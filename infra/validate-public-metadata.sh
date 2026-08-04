#!/usr/bin/env bash
set -euo pipefail

luxora_truth_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$luxora_truth_root"

luxora_truth_failed=0
luxora_truth_rg_args=(
  --hidden
  --glob '!**/.git/**'
  --glob '!**/node_modules/**'
  --glob '!**/dist/**'
  --glob '!**/build/**'
  --glob '!**/.build/**'
  --glob '!**/.gradle/**'
  --glob '!**/package-lock.json'
  --glob '!**/*.png'
  --glob '!**/*.jpg'
  --glob '!**/*.jpeg'
  --glob '!**/*.gif'
  --glob '!**/*.pdf'
)

luxora_truth_check() {
  local description="$1"
  local include_glob="$2"
  local pattern="$3"
  shift 3

  local matches
  if [[ "$include_glob" == "*" ]]; then
    matches="$(rg -n --pcre2 "${luxora_truth_rg_args[@]}" "$pattern" "$@" || true)"
  else
    matches="$(rg -n --pcre2 "${luxora_truth_rg_args[@]}" --glob "$include_glob" "$pattern" "$@" || true)"
  fi
  if [[ -n "$matches" ]]; then
    printf 'Public metadata truth failure: %s\n%s\n' "$description" "$matches" >&2
    luxora_truth_failed=1
  fi
}

# Product release tokens are human-facing `Beta-0.1`. The lowercase spelling is
# allowed only as the normalized Docker image tag `luxora-api:beta-0.1`.
# Internal package SemVer, Apple numeric bundle versions and HTTP/schema v1/v2
# are intentionally outside these patterns.
luxora_truth_check \
  'non-canonical Beta-style product release token' \
  '*' \
  '(?i)\b(?!beta-0\.1(?![._+-][a-z0-9]))beta[-._ ]*[0-9]+(?:[._-][0-9]+){1,3}(?:[-._+][a-z0-9]+)*\b' \
  .
luxora_truth_check \
  'lowercase product release token outside the Docker image tag' \
  '*' \
  '(?<!luxora-api:)beta-0\.1\b' \
  .
luxora_truth_check \
  'Markdown release metadata without canonical Beta-0.1' \
  '*.md' \
  '(?i)^\s*(?:[-*]\s*)?(?:\*\*)?(?:канонический(?:\s+публичный)?\s+релиз|публичный\s+релиз|релиз|canonical\s+public\s+release|public\s+release|release)(?:\*\*)?\s*:(?![^\n]*\bBeta-0\.1\b).*$' \
  .

# Explicit product owner/developer metadata must resolve to Flenym. Generic
# domain roles such as chat owner/author are deliberately not scanned.
luxora_truth_check \
  'owner/developer product metadata naming someone other than Flenym' \
  '*' \
  '(?i)^(?=[^\n]*(?:developer\s*(?:&|and|/)\s*owner|owner\s*(?:&|and|/)\s*developer|владелец\s+и\s+разработчик|разработчик\s+и\s+владелец)(?:\*\*)?\s*(?::|is\b|",\s*value:|</small><strong>))(?![^\n]*\bFlenym\b).*$' \
  .
luxora_truth_check \
  'Markdown owner metadata naming someone other than Flenym' \
  '*.md' \
  '(?i)^\s*(?:[-*]\s*)?(?:\*\*)?(?:owner|владелец)(?:\*\*)?\s*:(?![^\n]*\bFlenym\b).*$' \
  .
luxora_truth_check \
  'first-party package author naming someone other than Flenym' \
  'package.json' \
  '"author"\s*:\s*"(?!Flenym")' \
  .
luxora_truth_check \
  'first-party application copyright naming someone other than Flenym' \
  '*' \
  '(?i)^(?=[^\n]*(?:copyright|©))(?![^\n]*\bFlenym\b).*$' \
  apps/apple/project.yml apps/desktop/package.json apps/desktop/src/main.ts apps/web/src/App.tsx

if [[ "$luxora_truth_failed" -ne 0 ]]; then
  exit 1
fi

printf '%s\n' 'Public release/ownership metadata truth PASS (Beta-0.1; Flenym).'
