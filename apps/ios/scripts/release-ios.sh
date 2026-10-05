#!/usr/bin/env bash
# Build the iOS app for App Store Connect (TestFlight / App Store) and upload it, from this Mac.
# docs/STORE_RELEASE.md 「iOS」.
#
#   apps/ios/scripts/release-ios.sh [--export-only] [--dry-run]
#
# 1. Checks: the version (CFBundleShortVersionString) and the build number (CFBundleVersion) in Info.plist, and that
#    project.yml says the same. Nothing is bumped here: raise the build number (both files) and commit first —
#    App Store Connect refuses a build number it has already seen for the version. The Notification Service Extension
#    (NotificationService/Info.plist and its block in project.yml) carries the same version and build number.
# 2. xcodebuild archive: Release, generic iOS device, automatic signing (the team's Apple Distribution certificate and
#    an App Store profile are created / fetched with the App Store Connect API key, no Xcode login needed).
# 3. xcodebuild -exportArchive with ExportOptions (method app-store-connect, destination upload): signs the .ipa and
#    uploads it to App Store Connect. With --export-only the .ipa is written to the output folder instead.
#
# Settings, outside the repository in ~/.config/taylis/release.env (TAYLIS_RELEASE_ENV overrides the path), or the
# environment (wins):
#   ASC_KEY_ID      App Store Connect API key ID (Users and Access → Integrations → App Store Connect API)
#   ASC_ISSUER_ID   its issuer ID
#   ASC_KEY_PATH    the AuthKey_<ID>.p8 file (keep it outside the repository; it can be downloaded only once)
#   TAYLIS_IOS_BUILD_DIR  where archives go (default ~/Library/Caches/taylis-release/ios)
set -euo pipefail

usage() {
  sed -n '5p' "$0" | sed 's/^#   //'
  exit 2
}

DRY_RUN=0
EXPORT_ONLY=0
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --export-only) EXPORT_ONLY=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

RELEASE_ENV="${TAYLIS_RELEASE_ENV:-$HOME/.config/taylis/release.env}"
if [ -f "$RELEASE_ENV" ]; then
  while IFS='=' read -r name value; do
    value="${value%\"}"; value="${value#\"}"
    case "$name" in
      ASC_KEY_ID|ASC_ISSUER_ID|ASC_KEY_PATH|TAYLIS_IOS_BUILD_DIR) [ -n "${!name:-}" ] || export "$name=$value" ;;
    esac
  done < <(grep -E '^(ASC_KEY_ID|ASC_ISSUER_ID|ASC_KEY_PATH|TAYLIS_IOS_BUILD_DIR)=' "$RELEASE_ENV")
fi
ASC_KEY_ID="${ASC_KEY_ID:-}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-}"
ASC_KEY_PATH="${ASC_KEY_PATH:-}"
ASC_KEY_PATH="${ASC_KEY_PATH/#\~/$HOME}"

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
IOS="$REPO_ROOT/apps/ios"
PLIST="$IOS/ChikuwaChat/Info.plist"
TEAM_ID="3WF4YQB4L6"
BUNDLE_ID="jp.chikuwachat.ios"

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }
run() {
  if ((DRY_RUN)); then
    printf '  +'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
require() {
  local message="$1"; shift
  if ! "$@" >/dev/null 2>&1; then
    if ((DRY_RUN)); then echo "  (warning) $message" >&2; else fail "$message"; fi
  fi
}

# --- 1. checks -----------------------------------------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || fail "run this on a Mac"
command -v xcodebuild >/dev/null || fail "xcodebuild is missing (install Xcode)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")"
step "Checks: Taylis $VERSION (build $BUILD), $BUNDLE_ID, team $TEAM_ID"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "CFBundleShortVersionString is not X.Y.Z: $VERSION"
[[ "$BUILD" =~ ^[0-9]+$ ]] || fail "CFBundleVersion is not an integer: $BUILD"
grep -q "CFBundleShortVersionString: \"$VERSION\"" "$IOS/project.yml" || fail "project.yml's CFBundleShortVersionString differs from Info.plist ($VERSION)"
grep -q "CFBundleVersion: \"$BUILD\"" "$IOS/project.yml" || fail "project.yml's CFBundleVersion differs from Info.plist ($BUILD)"
# The Notification Service Extension (PUSH_NOTIFICATIONS.md §16) must carry the app's version and build number.
EXT_PLIST="$IOS/NotificationService/Info.plist"
EXT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$EXT_PLIST")"
EXT_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$EXT_PLIST")"
[[ "$EXT_VERSION" == "$VERSION" && "$EXT_BUILD" == "$BUILD" ]] ||
  fail "NotificationService/Info.plist says $EXT_VERSION ($EXT_BUILD), the app $VERSION ($BUILD): raise both (and project.yml)"
[[ "$(grep -c "CFBundleVersion: \"$BUILD\"" "$IOS/project.yml")" == 2 ]] ||
  fail "project.yml: the app's and NotificationService's CFBundleVersion must both be $BUILD"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- apps/ios ':!apps/ios/ChikuwaChat.xcodeproj/xcshareddata')" ]]; then
  echo "  (warning) apps/ios has uncommitted changes: the build will include them" >&2
fi
require "ASC_KEY_ID is not set ($RELEASE_ENV)" test -n "$ASC_KEY_ID"
require "ASC_ISSUER_ID is not set ($RELEASE_ENV)" test -n "$ASC_ISSUER_ID"
require "the API key file is missing: ${ASC_KEY_PATH:-<ASC_KEY_PATH not set>}" test -s "$ASC_KEY_PATH"
echo "  commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)   api key: ${ASC_KEY_ID:-<none>}"

AUTH=()
if [[ -n "$ASC_KEY_ID" && -n "$ASC_ISSUER_ID" && -n "$ASC_KEY_PATH" ]]; then
  AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID")
else
  AUTH=(-allowProvisioningUpdates)
fi

OUT="${TAYLIS_IOS_BUILD_DIR:-$HOME/Library/Caches/taylis-release/ios}"
OUT="${OUT/#\~/$HOME}/$VERSION-$BUILD"
ARCHIVE="$OUT/Taylis.xcarchive"
OPTIONS="$OUT/ExportOptions.plist"
run mkdir -p "$OUT"

# --- 2. archive ----------------------------------------------------------------------------------------

step "Archive (Release, generic iOS) → $ARCHIVE"
run rm -rf "$ARCHIVE"
run xcodebuild -project "$IOS/ChikuwaChat.xcodeproj" -scheme ChikuwaChat -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" "${AUTH[@]}" archive

# --- 3. export / upload --------------------------------------------------------------------------------

if ((EXPORT_ONLY)); then DESTINATION=export; else DESTINATION=upload; fi
step "Export ($DESTINATION) with $OPTIONS"
# manageAppVersionAndBuildNumber false: the build number is the one committed (App Store Connect would otherwise
# raise it in the uploaded build only, and the repository would no longer say which build is which).
OPTIONS_XML="$(cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>$DESTINATION</string>
	<key>teamID</key><string>$TEAM_ID</string>
	<key>signingStyle</key><string>automatic</string>
	<key>uploadSymbols</key><true/>
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
XML
)"
if ((DRY_RUN)); then
  echo "  + ExportOptions.plist: method app-store-connect, destination $DESTINATION, team $TEAM_ID, automatic signing"
else
  printf '%s\n' "$OPTIONS_XML" > "$OPTIONS"
fi
run rm -rf "$OUT/export"
run xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OPTIONS" -exportPath "$OUT/export" "${AUTH[@]}"

echo
if ((DRY_RUN)); then
  echo "dry run: nothing was built or uploaded (Taylis $VERSION build $BUILD)."
elif ((EXPORT_ONLY)); then
  echo "exported: $OUT/export (Taylis $VERSION build $BUILD). Upload it with Transporter, or run without --export-only."
else
  echo "uploaded Taylis $VERSION build $BUILD. App Store Connect processes it for a few minutes, then it shows in"
  echo "TestFlight (the export compliance question is answered by ITSAppUsesNonExemptEncryption = false)."
  echo "Next build: raise CFBundleVersion to $((BUILD + 1)) in apps/ios/ChikuwaChat/Info.plist, apps/ios/NotificationService/Info.plist"
  echo "and apps/ios/project.yml (both targets)."
fi
