#!/usr/bin/env bash
# Copy a desktop release's notes, as edited on GitHub, into its latest.json (the text the in-app updater shows).
# docs/DEVELOPMENT.md 「デスクトップ版のリリース」.
#
#   apps/desktop/scripts/sync-release-notes.sh vX.Y.Z [--dry-run]
#
# The notes are not part of the signed update (the signatures cover the binaries only), so this changes nothing else.
#   TAYLIS_RELEASES_REPO   where releases go (default kanotown/taylis-releases)
set -euo pipefail

TAG="${1:-}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '5p' "$0" | sed 's/^#   //'; exit 2; }
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1
REPO="${TAYLIS_RELEASES_REPO:-kanotown/taylis-releases}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gh release view "$TAG" -R "$REPO" --json body -q .body > "$WORK/notes.md"
gh release download "$TAG" -R "$REPO" -p latest.json -D "$WORK"
status=0
node -e '
const fs = require("fs");
const [file, notesFile] = process.argv.slice(1);
const json = JSON.parse(fs.readFileSync(file, "utf8"));
const notes = fs.readFileSync(notesFile, "utf8").trim();
if (json.notes === notes) process.exit(3);
json.notes = notes;
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
' "$WORK/latest.json" "$WORK/notes.md" || status=$?
if [ "$status" -eq 3 ]; then echo "$TAG: latest.json already has the release's notes"; exit 0; fi
[ "$status" -eq 0 ] || exit "$status"
if ((DRY_RUN)); then
  echo "$TAG: latest.json would get these notes:"; cat "$WORK/notes.md"
else
  gh release upload "$TAG" -R "$REPO" "$WORK/latest.json" --clobber
  echo "$TAG: latest.json now has the release's notes"
fi
