#!/usr/bin/env bash
# Publish a desktop release (installers + in-app update) to the public, binaries-only repository
# kanotown/taylis-releases, from this Mac. docs/DEVELOPMENT.md 「デスクトップ版のリリース」.
#
#   apps/desktop/scripts/release-desktop.sh vX.Y.Z [--notes FILE] [--rebuild-windows] [--dry-run]
#
# 1. Windows: the `desktop` workflow builds the installers on the tag (dispatched here, or a successful run on the tag
#    whose artifact is still there is reused); its artifact is downloaded and the NSIS installer is signed here with
#    the updater key (the key never goes to GitHub).
# 2. macOS: a universal build (Apple silicon + Intel) from a temporary worktree of the tag; tauri signs the updater
#    bundle (.app.tar.gz) with the same key. Developer ID signing and notarisation when APPLE_SIGNING_IDENTITY /
#    TAYLIS_NOTARY_PROFILE are set, else ad-hoc as before.
# 3. latest.json: windows-x86_64 (NSIS), darwin-aarch64 and darwin-x86_64 (the same universal .app.tar.gz).
# 4. The GitHub Release vX.Y.Z on kanotown/taylis-releases with every file (re-running uploads with --clobber).
#
# Environment:
#   TAYLIS_UPDATER_KEY       the updater's private key (default ~/.tauri/taylis-updater.key, no password). Losing it
#                            means the installed apps can no longer be updated: keep a backup.
#   TAYLIS_RELEASES_REPO     where releases go (default kanotown/taylis-releases)
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: … (TEAMID)" — sign the Mac app with it (else ad-hoc "-")
#   TAYLIS_NOTARY_PROFILE    a `xcrun notarytool store-credentials` keychain profile — notarise and staple the app and
#                            the .dmg (needs APPLE_SIGNING_IDENTITY)
#   TAYLIS_RELEASE_CACHE     cargo's target directory across releases (default ~/Library/Caches/taylis-release)
set -euo pipefail

usage() {
  sed -n '5p' "$0" | sed 's/^#   //'
  exit 2
}

TAG=""
NOTES_FILE=""
DRY_RUN=0
REBUILD_WINDOWS=0
while (($#)); do
  case "$1" in
    --notes) NOTES_FILE="${2:?--notes needs a file}"; shift 2 ;;
    --notes=*) NOTES_FILE="${1#--notes=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rebuild-windows) REBUILD_WINDOWS=1; shift ;;
    -h|--help) usage ;;
    v*) [[ -z "$TAG" ]] || usage; TAG="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[[ -n "$TAG" ]] || usage
if [[ ! "$TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?)$ ]]; then
  echo "not a release tag (vX.Y.Z): $TAG" >&2
  exit 2
fi
VERSION="${BASH_REMATCH[1]}"

# This Mac's signing settings, kept outside the repository (no secrets: a certificate's SHA-1 and a notarytool
# keychain profile name), e.g.
#   APPLE_SIGNING_IDENTITY=<SHA-1 of the Developer ID Application certificate>
#   TAYLIS_NOTARY_PROFILE=taylis-notary
# Variables already set in the environment win. A SHA-1 is safer than the certificate's name: an identity imported
# twice makes the name ambiguous for codesign.
RELEASE_ENV="${TAYLIS_RELEASE_ENV:-$HOME/.config/taylis/release.env}"
if [ -f "$RELEASE_ENV" ]; then
  while IFS='=' read -r name value; do
    case "$name" in
      APPLE_SIGNING_IDENTITY|TAYLIS_NOTARY_PROFILE) [ -n "${!name:-}" ] || export "$name=$value" ;;
    esac
  done < <(grep -E '^(APPLE_SIGNING_IDENTITY|TAYLIS_NOTARY_PROFILE)=' "$RELEASE_ENV")
fi

KEY="${TAYLIS_UPDATER_KEY:-$HOME/.tauri/taylis-updater.key}"
RELEASES_REPO="${TAYLIS_RELEASES_REPO:-kanotown/taylis-releases}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
NOTARY_PROFILE="${TAYLIS_NOTARY_PROFILE:-}"
CACHE="${TAYLIS_RELEASE_CACHE:-$HOME/Library/Caches/taylis-release}"
WORKFLOW="desktop.yml"
ARTIFACT="desktop-$TAG-windows-latest"
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }
# Runs a command, or only shows it with --dry-run.
run() {
  if ((DRY_RUN)); then
    printf '  +'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
# A check that stops a real release; a dry run only warns, to show the rest of the steps.
require() {
  local message="$1"; shift
  if ! "$@" >/dev/null 2>&1; then
    if ((DRY_RUN)); then echo "  (warning) $message" >&2; else fail "$message"; fi
  fi
}

# --- checks ------------------------------------------------------------------------------------------

step "Checks: $TAG (version $VERSION) → $RELEASES_REPO"
for tool in git gh node npm cargo rustup; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
[[ "$(uname -s)" == "Darwin" ]] || fail "run this on a Mac (the macOS build is local)"
require "tag $TAG does not exist here (git fetch --tags)" git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG"
require "tag $TAG is not on GitHub (git push origin $TAG): the Windows build runs there" \
  bash -c "git -C '$REPO_ROOT' ls-remote --exit-code --tags origin 'refs/tags/$TAG'"
require "gh is not signed in (gh auth login)" gh auth status
require "the updater key is missing: $KEY (restore it from the backup; a new key cannot update existing installs)" test -s "$KEY"
require "$TAG predates in-app updates (no plugins.updater in its tauri.conf.json)" \
  bash -c "git -C '$REPO_ROOT' show '$TAG:apps/desktop/src-tauri/tauri.conf.json' | grep -q createUpdaterArtifacts"
if [[ -n "$NOTES_FILE" ]]; then
  [[ -s "$NOTES_FILE" ]] || fail "notes file is missing or empty: $NOTES_FILE"
  NOTES_FILE="$(cd "$(dirname "$NOTES_FILE")" && pwd)/$(basename "$NOTES_FILE")"
fi
if [[ -n "$NOTARY_PROFILE" && -z "$SIGNING_IDENTITY" ]]; then
  fail "TAYLIS_NOTARY_PROFILE needs APPLE_SIGNING_IDENTITY (notarisation needs a Developer ID signature)"
fi
SOURCE_REPO="$(cd "$REPO_ROOT" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo kanotown/chikuwachat)"
echo "  source: $SOURCE_REPO   key: $KEY   mac signing: ${SIGNING_IDENTITY:-ad-hoc}   notarise: ${NOTARY_PROFILE:-no}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/taylis-release.XXXXXX")"
SRC="$WORK/src"
ASSETS="$WORK/assets"
mkdir -p "$ASSETS"
cleanup() {
  if [[ -d "$SRC" ]]; then git -C "$REPO_ROOT" worktree remove --force "$SRC" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- 1. Windows ----------------------------------------------------------------------------------------

step "Windows: the desktop workflow on $TAG"
RUN_ID=""
if ((!REBUILD_WINDOWS)) && ((!DRY_RUN)); then
  # A successful run on the tag whose Windows artifact has not expired yet (a re-run of this script).
  for id in $(gh run list -R "$SOURCE_REPO" --workflow "$WORKFLOW" --branch "$TAG" --status success --limit 5 --json databaseId -q '.[].databaseId'); do
    if gh api "repos/$SOURCE_REPO/actions/runs/$id/artifacts" -q ".artifacts[] | select(.name == \"$ARTIFACT\" and .expired == false) | .name" | grep -q .; then
      RUN_ID="$id"
      echo "  reusing run $RUN_ID"
      break
    fi
  done
fi
if [[ -z "$RUN_ID" ]]; then
  STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run gh workflow run "$WORKFLOW" -R "$SOURCE_REPO" --ref "$TAG" -f os=windows
  if ((DRY_RUN)); then
    RUN_ID="<run id>"
  else
    for _ in $(seq 1 30); do
      sleep 5
      RUN_ID="$(gh run list -R "$SOURCE_REPO" --workflow "$WORKFLOW" --branch "$TAG" --event workflow_dispatch --limit 5 \
        --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$STARTED\")] | last | .databaseId // empty")"
      [[ -n "$RUN_ID" ]] && break
    done
    [[ -n "$RUN_ID" ]] || fail "the dispatched run did not show up (gh run list -R $SOURCE_REPO --workflow $WORKFLOW)"
    echo "  run $RUN_ID: https://github.com/$SOURCE_REPO/actions/runs/$RUN_ID"
  fi
  run gh run watch "$RUN_ID" -R "$SOURCE_REPO" --exit-status --interval 30
fi
run gh run download "$RUN_ID" -R "$SOURCE_REPO" -n "$ARTIFACT" -D "$WORK/windows"

# --- 2. macOS ------------------------------------------------------------------------------------------

step "macOS: universal build from a worktree of $TAG"
run git -C "$REPO_ROOT" worktree add --detach "$SRC" "$TAG"
run rustup target add aarch64-apple-darwin x86_64-apple-darwin
DESKTOP="$SRC/apps/desktop"
CONFIG="$WORK/release.conf.json"
if [[ -n "$SIGNING_IDENTITY" ]]; then
  SIGN_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$SIGNING_IDENTITY")"
  echo "{\"version\":\"$VERSION\",\"bundle\":{\"macOS\":{\"signingIdentity\":$SIGN_JSON}}}" > "$CONFIG"
else
  echo "{\"version\":\"$VERSION\"}" > "$CONFIG"
fi
echo "  config: $(cat "$CONFIG")"
# The .dmg too when notarising: the one shipped is made again after the app is stapled (below), with the create-dmg
# script tauri's dmg step leaves next to its .dmg, so that it has the same window (background, arrow, positions).
MAC_BUNDLES="app,dmg"
export CARGO_TARGET_DIR="$CACHE/target"
BUNDLE_DIR="$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle"
if ((DRY_RUN)); then
  echo "  + (cd $DESKTOP && npm ci && TAURI_SIGNING_PRIVATE_KEY=<$KEY> npx tauri build --target universal-apple-darwin --bundles $MAC_BUNDLES --config $CONFIG)"
else
  rm -rf "$BUNDLE_DIR"
  (
    cd "$DESKTOP"
    npm ci
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
      npx tauri build --target universal-apple-darwin --bundles "$MAC_BUNDLES" --config "$CONFIG"
  )
fi
APP="$BUNDLE_DIR/macos/Taylis.app"
TARBALL="$BUNDLE_DIR/macos/Taylis.app.tar.gz"
DMG="$ASSETS/Taylis_${VERSION}_universal.dmg"

# The .dmg of an app, laid out as tauri.conf.json `bundle.macOS.dmg` says (the window tauri's own .dmg has: the
# background with 「Taylis を Applications にドラッグしてください」, the window size, the app and Applications positions),
# with tauri's create-dmg script (bundle/dmg/bundle_dmg.sh; it lays the window out with Finder through AppleScript).
# A tag without that config gets the plain .dmg as before.
make_dmg() {
  local app="$1" out="$2" script="$BUNDLE_DIR/dmg/bundle_dmg.sh" conf="$DESKTOP/src-tauri/tauri.conf.json" layout
  ((DRY_RUN)) && [[ ! -f "$conf" ]] && conf="$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json" # no worktree in a dry run
  layout="$(node -e '
    const d = require(process.argv[1]).bundle?.macOS?.dmg;
    if (d?.background && d.windowSize && d.appPosition && d.applicationFolderPosition)
      console.log([d.windowSize.width, d.windowSize.height, d.appPosition.x, d.appPosition.y,
        d.applicationFolderPosition.x, d.applicationFolderPosition.y, d.background].join(" "));
  ' "$conf")"
  run rm -rf "$WORK/dmg" "$out"
  run mkdir -p "$WORK/dmg"
  run ditto "$app" "$WORK/dmg/Taylis.app"
  if [[ -z "$layout" ]]; then
    run ln -s /Applications "$WORK/dmg/Applications"
    run hdiutil create -volname Taylis -srcfolder "$WORK/dmg" -ov -format UDZO "$out"
    return
  fi
  ((DRY_RUN)) || [[ -x "$script" ]] || fail "tauri's dmg script is missing: $script"
  local w h ax ay fx fy background
  read -r w h ax ay fx fy background <<<"$layout"
  run "$script" --volname Taylis --volicon "$DESKTOP/src-tauri/icons/icon.icns" \
    --background "$DESKTOP/src-tauri/$background" --window-size "$w" "$h" \
    --icon Taylis.app "$ax" "$ay" --hide-extension Taylis.app --app-drop-link "$fx" "$fy" \
    "$out" "$WORK/dmg"
}

# Signs a file with the updater key (the signature binds the version, as tauri build does).
updater_sign() {
  run env TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bash -c 'cd "$1" && npx tauri signer sign -f "$2" --app-version "$3" "$4" >/dev/null' _ \
    "$DESKTOP" "$KEY" "$VERSION" "$1"
}

if [[ -n "$NOTARY_PROFILE" ]]; then
  step "macOS: notarise and staple ($NOTARY_PROFILE)"
  run ditto -c -k --keepParent "$APP" "$WORK/Taylis-notarise.zip"
  run xcrun notarytool submit "$WORK/Taylis-notarise.zip" --keychain-profile "$NOTARY_PROFILE" --wait
  run xcrun stapler staple "$APP"
  # The updater bundle holds the stapled app: made again, and signed again.
  run rm -f "$TARBALL" "$TARBALL.sig"
  run env COPYFILE_DISABLE=1 tar -C "$(dirname "$APP")" -czf "$TARBALL" "$(basename "$APP")"
  updater_sign "$TARBALL"
  make_dmg "$APP" "$DMG"
  run codesign --force --sign "$SIGNING_IDENTITY" "$DMG"
  run xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  run xcrun stapler staple "$DMG"
else
  run cp "$BUNDLE_DIR/dmg/Taylis_${VERSION}_universal.dmg" "$DMG"
fi
# Kept under tauri's name (the signature's trusted comment names the file); one per release, universal.
MAC_UPDATE="Taylis.app.tar.gz"
run cp "$TARBALL" "$ASSETS/$MAC_UPDATE"
run cp "$TARBALL.sig" "$ASSETS/$MAC_UPDATE.sig"

# --- Windows' files, signed here ------------------------------------------------------------------------

step "Windows: sign the NSIS installer for the updater"
WIN_SETUP="Taylis_${VERSION}_x64-setup.exe"
if ((DRY_RUN)); then
  echo "  + cp <artifact>/nsis/$WIN_SETUP <artifact>/msi/Taylis_${VERSION}_x64_en-US.msi $ASSETS/"
else
  found="$(find "$WORK/windows" -name "$WIN_SETUP" -print -quit)"
  [[ -n "$found" ]] || fail "$WIN_SETUP is not in the artifact (was $TAG built with this version? see $WORK/windows)"
  cp "$found" "$ASSETS/"
  find "$WORK/windows" -name "*.msi" -exec cp {} "$ASSETS/" \;
fi
updater_sign "$ASSETS/$WIN_SETUP"

# --- 3. latest.json -------------------------------------------------------------------------------------

step "latest.json"
NOTES="$WORK/notes.md"
if [[ -n "$NOTES_FILE" ]]; then cp "$NOTES_FILE" "$NOTES"; else echo "Taylis $TAG" > "$NOTES"; fi
DOWNLOAD="https://github.com/$RELEASES_REPO/releases/download/$TAG"
if ((DRY_RUN)); then
  echo "  + latest.json: version $VERSION, notes \"$(head -n 1 "$NOTES")\", windows-x86_64 → $DOWNLOAD/$WIN_SETUP,"
  echo "    darwin-aarch64 / darwin-x86_64 → $DOWNLOAD/$MAC_UPDATE (signatures from the .sig files)"
else
  node - "$VERSION" "$NOTES" "$DOWNLOAD" "$ASSETS" "$WIN_SETUP" "$MAC_UPDATE" > "$ASSETS/latest.json" <<'JS'
const fs = require("fs");
const path = require("path");
const [version, notes, download, assets, winSetup, macUpdate] = process.argv.slice(2);
const sig = (file) => fs.readFileSync(path.join(assets, `${file}.sig`), "utf8").trim();
const mac = { signature: sig(macUpdate), url: `${download}/${macUpdate}` };
const manifest = {
  version,
  notes: fs.readFileSync(notes, "utf8").trim(),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": { signature: sig(winSetup), url: `${download}/${winSetup}` },
    "darwin-aarch64": mac,
    "darwin-x86_64": mac,
  },
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
JS
  cat "$ASSETS/latest.json"
fi

# --- 4. the release -------------------------------------------------------------------------------------

step "GitHub Release $TAG on $RELEASES_REPO"
if ((DRY_RUN)); then
  FILES=("$ASSETS/$WIN_SETUP" "$ASSETS/$WIN_SETUP.sig" "$ASSETS/Taylis_${VERSION}_x64_en-US.msi" "$DMG" "$ASSETS/$MAC_UPDATE" "$ASSETS/$MAC_UPDATE.sig" "$ASSETS/latest.json")
else
  FILES=("$ASSETS"/*)
fi
if ((!DRY_RUN)) && gh release view "$TAG" -R "$RELEASES_REPO" >/dev/null 2>&1; then
  echo "  the release exists: replacing its files"
  run gh release upload "$TAG" -R "$RELEASES_REPO" --clobber "${FILES[@]}"
  run gh release edit "$TAG" -R "$RELEASES_REPO" --notes-file "$NOTES"
else
  run gh release create "$TAG" -R "$RELEASES_REPO" --title "Taylis $TAG" --notes-file "$NOTES" --latest "${FILES[@]}"
fi
if ((DRY_RUN)); then
  echo
  echo "dry run: nothing was built or published. Release URL would be https://github.com/$RELEASES_REPO/releases/tag/$TAG"
else
  echo
  echo "released: $(gh release view "$TAG" -R "$RELEASES_REPO" --json url -q .url)"
fi
