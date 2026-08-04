#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
kit_root="$repo_root/apps/apple/Sources/LuxoraKit"

ui_matches=$(
  rg -n -P \
    '(Text|Button|Label|Section|Picker|Toggle|LabeledContent|navigationTitle|accessibilityLabel|accessibilityHint)\(\s*"[A-Za-z][^"\p{Cyrillic}]*"' \
    "$kit_root/Views" "$kit_root/Design" \
    --glob '*.swift' \
  | rg -v 'Text\("Luxora"\)|Text\("Beta-0\.1|Section\("Beta-0\.1"\)|Label\("luxora\.app/|accessibilityLabel\("Luxora"\)|value: "Flenym"' \
  || true
)

jargon_matches=$(
  rg -n '"[^"\n]*(AuthenticationServices|CallKit|ReplayKit|E2EE|server gate|media-gate|media-contract|media-cache|offline-cache|production-|durable jobs|APNs|Realtime)' \
    "$kit_root/Resources/ru.lproj/Localizable.strings" "$kit_root/Views" \
    --glob '*.swift' \
  || true
)

if [ -n "$ui_matches" ] || [ -n "$jargon_matches" ]; then
  printf '%s\n' 'Russian UI source scan failed.'
  if [ -n "$ui_matches" ]; then
    printf '%s\n' "$ui_matches"
  fi
  if [ -n "$jargon_matches" ]; then
    printf '%s\n' "$jargon_matches"
  fi
  exit 1
fi

printf '%s\n' 'Russian UI source scan passed.'
