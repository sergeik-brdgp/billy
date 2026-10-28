#!/usr/bin/env bash
# Puts the four kit fixtures on every running Android device/emulator and every booted iOS simulator.
# Idempotent: re-running overwrites the same files. Never touches mock-kit/ sources;
# it only runs the kit's own `fixtures:oversize` generator when oversize.csv is missing.
#
# Usage: scripts/push-fixtures.sh [android|ios]   (default: both)
#   Android: adb push → /sdcard/Download/   (Files / picker → Downloads)
#   iOS sim: copy into the Files app "On My iPhone" local storage → folder "Statement fixtures"
set -euo pipefail

target="${1:-all}"
case "$target" in
  all | android | ios) ;;
  *)
    echo "usage: $0 [android|ios]" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures_dir="$repo_root/mock-kit/fixtures"
fixtures=(statement.csv statement.pdf spoofed.pdf oversize.csv)
ios_folder="Statement fixtures"
pushed=0

if [[ ! -f "$fixtures_dir/oversize.csv" ]]; then
  echo "oversize.csv missing → npm --prefix mock-kit run fixtures:oversize"
  npm --prefix "$repo_root/mock-kit" run --silent fixtures:oversize
fi
for name in "${fixtures[@]}"; do
  if [[ ! -f "$fixtures_dir/$name" ]]; then
    echo "error: fixture not found: mock-kit/fixtures/$name" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------- Android
find_adb() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return 0
  fi
  local sdk
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [[ -n "$sdk" && -x "$sdk/platform-tools/adb" ]]; then
      echo "$sdk/platform-tools/adb"
      return 0
    fi
  done
  return 1
}

push_android() {
  local adb serials serial name
  if ! adb="$(find_adb)"; then
    echo "android: adb not found (set ANDROID_HOME or install platform-tools) — skipped"
    return 0
  fi
  # Only devices in the "device" state (skips offline / unauthorized ones).
  serials="$("$adb" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  if [[ -z "$serials" ]]; then
    echo "android: no running emulator/device (adb devices) — skipped"
    return 0
  fi
  while IFS= read -r serial; do
    [[ -z "$serial" ]] && continue
    echo "android [$serial]: pushing to /sdcard/Download/"
    for name in "${fixtures[@]}"; do
      "$adb" -s "$serial" push "$fixtures_dir/$name" "/sdcard/Download/$name" >/dev/null
      # Ask MediaStore to index the file so DocumentsUI lists it immediately (best effort).
      "$adb" -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
        -d "file:///sdcard/Download/$name" >/dev/null 2>&1 || true
    done
    "$adb" -s "$serial" shell content call --uri content://media --method scan_volume \
      --arg external_primary >/dev/null 2>&1 || true
    "$adb" -s "$serial" shell ls -l /sdcard/Download/ |
      grep -E "($(IFS='|'; echo "${fixtures[*]}"))$" | sed 's/^/    /' || true
    pushed=$((pushed + 1))
  done <<<"$serials"
}

# ---------------------------------------------------------------- iOS simulator
print_ios_manual() {
  cat <<EOF
ios: fallback — add the fixtures by hand:
    1. open -R "$fixtures_dir/statement.csv"   (reveals the folder in Finder)
    2. drag statement.csv, statement.pdf, spoofed.pdf, oversize.csv onto the Simulator window
    3. in the sheet that opens choose "On My iPhone" → Save
EOF
}

push_ios() {
  local udids udid group dest name
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "ios: xcrun not found (not macOS / no Xcode) — skipped"
    return 0
  fi
  udids="$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p')"
  if [[ -z "$udids" ]]; then
    echo "ios: no booted simulator (xcrun simctl list devices booted) — skipped"
    return 0
  fi
  while IFS= read -r udid; do
    [[ -z "$udid" ]] && continue
    # The Files app "On My iPhone" location is the File Provider local-storage app group.
    group="$(xcrun simctl get_app_container "$udid" com.apple.DocumentsApp groups 2>/dev/null |
      awk -F'\t' '$1 == "group.com.apple.FileProvider.LocalStorage" { print $2 }')"
    if [[ -z "$group" || ! -d "$group" ]]; then
      echo "ios [$udid]: Files app local storage not found"
      print_ios_manual
      continue
    fi
    dest="$group/File Provider Storage/$ios_folder"
    mkdir -p "$dest"
    echo "ios [$udid]: copying to Files → On My iPhone → $ios_folder"
    for name in "${fixtures[@]}"; do
      cp -f "$fixtures_dir/$name" "$dest/$name"
      printf '    %10s bytes  %s\n' "$(wc -c <"$dest/$name" | tr -d ' ')" "$name"
    done
    pushed=$((pushed + 1))
  done <<<"$udids"
}

[[ "$target" == all || "$target" == android ]] && push_android
[[ "$target" == all || "$target" == ios ]] && push_ios

if [[ "$pushed" -eq 0 ]]; then
  echo "nothing pushed: no running target for '$target' (Android emulator/device or booted iOS simulator)" >&2
  [[ "$target" != android ]] && print_ios_manual >&2
  exit 1
fi
echo "done: fixtures on $pushed target(s)"
