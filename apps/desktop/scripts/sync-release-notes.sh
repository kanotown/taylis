#!/usr/bin/env bash
# Copy a desktop release's notes, as edited on GitHub, into its latest.json (the text the in-app updater shows), and
# into the latest.json mirrored to the legacy repository when that release exists there.
# docs/DEVELOPMENT.md 「デスクトップ版のリリース」.
#
#   apps/desktop/scripts/sync-release-notes.sh vX.Y.Z [--dry-run]
#
# The notes are not part of the signed update (the signatures cover the binaries only), so this changes nothing else.
# The notes are always taken from the release in TAYLIS_RELEASES_REPO (edit them there).
#   TAYLIS_RELEASES_REPO          where releases go (default kanotown/taylis)
#   TAYLIS_LEGACY_RELEASES_REPO   the latest.json mirror for apps before v0.1.42 (default kanotown/taylis-releases;
#                                 empty: none)
set -euo pipefail

TAG="${1:-}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '6p' "$0" | sed 's/^#   //'; exit 2; }
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1
REPO="${TAYLIS_RELEASES_REPO:-kanotown/taylis}"
LEGACY_REPO="${TAYLIS_LEGACY_RELEASES_REPO-kanotown/taylis-releases}"
[[ "$LEGACY_REPO" != "$REPO" ]] || LEGACY_REPO=""
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gh release view "$TAG" -R "$REPO" --json body -q .body > "$WORK/notes.md"

# Puts the notes into one repository's latest.json of $TAG.
sync_repo() {
  local repo="$1" dir="$WORK/$2" status=0
  mkdir -p "$dir"
  gh release download "$TAG" -R "$repo" -p latest.json -D "$dir"
  node -e '
const fs = require("fs");
const [file, notesFile] = process.argv.slice(1);
const json = JSON.parse(fs.readFileSync(file, "utf8"));
const notes = fs.readFileSync(notesFile, "utf8").trim();
if (json.notes === notes) process.exit(3);
json.notes = notes;
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
' "$dir/latest.json" "$WORK/notes.md" || status=$?
  if [ "$status" -eq 3 ]; then echo "$TAG ($repo): latest.json already has the release's notes"; return 0; fi
  [ "$status" -eq 0 ] || return "$status"
  if ((DRY_RUN)); then
    echo "$TAG ($repo): latest.json would get these notes:"; cat "$WORK/notes.md"
  else
    gh release upload "$TAG" -R "$repo" "$dir/latest.json" --clobber
    echo "$TAG ($repo): latest.json now has the release's notes"
  fi
}

sync_repo "$REPO" main
if [[ -n "$LEGACY_REPO" ]]; then
  if gh release view "$TAG" -R "$LEGACY_REPO" >/dev/null 2>&1; then
    sync_repo "$LEGACY_REPO" legacy
  else
    echo "$TAG ($LEGACY_REPO): no such release, nothing to mirror"
  fi
fi
