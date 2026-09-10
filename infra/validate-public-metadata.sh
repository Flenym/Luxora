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
  if command -v rg >/dev/null 2>&1; then
    if [[ "$include_glob" == "*" ]]; then
      matches="$(rg -n --pcre2 "${luxora_truth_rg_args[@]}" "$pattern" "$@" || true)"
    else
      matches="$(rg -n --pcre2 "${luxora_truth_rg_args[@]}" --glob "$include_glob" "$pattern" "$@" || true)"
    fi
  else
    matches="$(luxora_truth_grep "$include_glob" "$pattern" "$@" || true)"
  fi
  if [[ -n "$matches" ]]; then
    printf 'Public metadata truth failure: %s\n%s\n' "$description" "$matches" >&2
    luxora_truth_failed=1
  fi
}

# Portability shim: GitHub ubuntu-24.04 runners and plain Git Bash installs do
# not ship ripgrep. The truth patterns are pure PCRE, so GNU grep -P covers
# them with the same include/exclude semantics.
luxora_truth_grep() {
  local include_glob="$1"
  local pattern="$2"
  shift 2

  local grep_args=(-rnP --binary-files=without-match)
  local arg
  for arg in "${luxora_truth_rg_args[@]}"; do
    case "$arg" in
      '!**/.git/**') grep_args+=(--exclude-dir=.git) ;;
      '!**/node_modules/**') grep_args+=(--exclude-dir=node_modules) ;;
      '!**/dist/**') grep_args+=(--exclude-dir=dist) ;;
      '!**/build/**') grep_args+=(--exclude-dir=build) ;;
      '!**/.build/**') grep_args+=(--exclude-dir=.build) ;;
      '!**/.gradle/**') grep_args+=(--exclude-dir=.gradle) ;;
      '!**/package-lock.json') grep_args+=(--exclude=package-lock.json) ;;
      '!**/*.png'|'!**/*.jpg'|'!**/*.jpeg'|'!**/*.gif'|'!**/*.pdf') ;;
    esac
  done
  if [[ "$include_glob" != "*" ]]; then
    grep_args+=(--include="$include_glob")
  fi

  local paths=("$@")
  if [[ ${#paths[@]} -eq 0 ]]; then
    paths=(.)
  fi
  grep "${grep_args[@]}" -- "$pattern" "${paths[@]}" 2>/dev/null
}

# Product release tokens are human-facing `Beta-0.1`. The lowercase spelling is
# allowed only as a normalized first-party Docker image tag:
# `luxora-api:beta-0.1` or `luxora-otp-console:beta-0.1`.
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
  '(?<!luxora-api:)(?<!luxora-otp-console:)beta-0\.1\b' \
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
