#!/usr/bin/env bash
# Build the signed Android App Bundle (AAB) for Google Play, from this Mac. docs/STORE_RELEASE.md 「Android」.
#
#   apps/android/scripts/release-android.sh [--skip-checks] [--dry-run]
#
# 1. Checks: versionName / versionCode in app/build.gradle.kts (nothing is bumped here: raise versionCode, and
#    versionName for a new version, and commit first — Play refuses a versionCode it has already seen), the upload
#    key's settings, and app/google-services.json (without it the build has no FCM push).
# 2. Unit tests and lint (skipped with --skip-checks), then :app:bundleRelease signed with the upload key.
# 3. Verifies the signature and copies the AAB to the output folder as taylis-<versionName>-<versionCode>.aab.
#    Upload it by hand in Play Console (Test and release → a track → Create new release).
#
# Settings (docs/STORE_RELEASE.md): ~/.config/taylis/android-release.properties (TAYLIS_ANDROID_SIGNING overrides the
# path) with storeFile / storePassword / keyAlias / keyPassword, or TAYLIS_ANDROID_STORE_FILE /
# TAYLIS_ANDROID_STORE_PASSWORD / TAYLIS_ANDROID_KEY_ALIAS / TAYLIS_ANDROID_KEY_PASSWORD in the environment.
#   ANDROID_HOME                the SDK (default ~/Library/Android/sdk)
#   TAYLIS_ANDROID_BUILD_DIR    where the AAB is copied (default ~/Library/Caches/taylis-release/android)
set -euo pipefail

usage() {
  sed -n '4p' "$0" | sed 's/^#   //'
  exit 2
}

DRY_RUN=0
SKIP_CHECKS=0
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ANDROID="$REPO_ROOT/apps/android"
GRADLE_FILE="$ANDROID/app/build.gradle.kts"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
SIGNING="${TAYLIS_ANDROID_SIGNING:-$HOME/.config/taylis/android-release.properties}"

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
# A signing setting from the environment or the properties file (as app/build.gradle.kts reads it).
setting() {
  local key="$1" env="$2"
  if [[ -n "${!env:-}" ]]; then echo "${!env}"; return; fi
  [[ -f "$SIGNING" ]] && sed -n "s/^[[:space:]]*$key[[:space:]]*=[[:space:]]*//p" "$SIGNING" | head -n 1
  return 0
}

# --- 1. checks -----------------------------------------------------------------------------------------

VERSION_NAME="$(sed -n 's/^[[:space:]]*versionName = "\(.*\)"/\1/p' "$GRADLE_FILE")"
VERSION_CODE="$(sed -n 's/^[[:space:]]*versionCode = \([0-9]*\)$/\1/p' "$GRADLE_FILE")"
step "Checks: Taylis $VERSION_NAME (versionCode $VERSION_CODE), jp.chikuwachat.android"
[[ "$VERSION_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "versionName is not X.Y.Z: $VERSION_NAME"
[[ "$VERSION_CODE" =~ ^[0-9]+$ ]] || fail "versionCode is not an integer: $VERSION_CODE"
[[ -d "$ANDROID_HOME" ]] || fail "the Android SDK is missing: $ANDROID_HOME"
command -v java >/dev/null || fail "java is not installed"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- apps/android)" ]]; then
  echo "  (warning) apps/android has uncommitted changes: the build will include them" >&2
fi
require "app/google-services.json is missing: the build would have no FCM push (copy it from the Firebase console)" \
  test -s "$ANDROID/app/google-services.json"
STORE_FILE="$(setting storeFile TAYLIS_ANDROID_STORE_FILE)"
STORE_FILE="${STORE_FILE/#\~/$HOME}"
KEY_ALIAS="$(setting keyAlias TAYLIS_ANDROID_KEY_ALIAS)"
require "the upload key is not set up ($SIGNING: storeFile / storePassword / keyAlias / keyPassword)" \
  test -n "$STORE_FILE" -a -n "$KEY_ALIAS" -a -n "$(setting storePassword TAYLIS_ANDROID_STORE_PASSWORD)" \
  -a -n "$(setting keyPassword TAYLIS_ANDROID_KEY_PASSWORD)"
require "the upload keystore is missing: ${STORE_FILE:-<storeFile not set>}" test -s "$STORE_FILE"
echo "  commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)   upload key: ${STORE_FILE:-<none>} (${KEY_ALIAS:-?})"

OUT="${TAYLIS_ANDROID_BUILD_DIR:-$HOME/Library/Caches/taylis-release/android}"
OUT="${OUT/#\~/$HOME}"
AAB="$ANDROID/app/build/outputs/bundle/release/app-release.aab"
TARGET="$OUT/taylis-$VERSION_NAME-$VERSION_CODE.aab"

# --- 2. build ------------------------------------------------------------------------------------------

TASKS=(:app:bundleRelease)
if ((!SKIP_CHECKS)); then TASKS=(:app:testDebugUnitTest :app:lintRelease "${TASKS[@]}"); fi
step "Gradle: ${TASKS[*]}"
run rm -f "$AAB"
run "$ANDROID/gradlew" -p "$ANDROID" "${TASKS[@]}"

# --- 3. verify and copy --------------------------------------------------------------------------------

step "Verify the signature → $TARGET"
if ((DRY_RUN)); then
  echo "  + jarsigner -verify $AAB (signed by the upload key)"
else
  [[ -s "$AAB" ]] || fail "no AAB at $AAB"
  # "jar verified." (in English whatever the Mac's language); an unsigned bundle says "jar is unsigned." and exits 0.
  VERIFY="$(jarsigner -J-Duser.language=en -verify "$AAB" 2>&1 || true)"
  grep -qx "jar verified." <<<"$VERIFY" || fail "the AAB is not signed (check $SIGNING): $(grep -m1 . <<<"$VERIFY")"
fi
run mkdir -p "$OUT"
run cp "$AAB" "$TARGET"

echo
if ((DRY_RUN)); then
  echo "dry run: nothing was built (Taylis $VERSION_NAME, versionCode $VERSION_CODE)."
else
  echo "built: $TARGET"
  echo "Upload it in Play Console (internal testing first). Next build: versionCode $((VERSION_CODE + 1)) in apps/android/app/build.gradle.kts."
fi
