#!/bin/sh
# Updates the DJ laptop to the latest main. Run: tools/update.sh
# Rebuilds and installs the plugin only when its sources changed since the last install.
set -e
cd "$(dirname "$0")/.."

[ "$(git branch --show-current)" = main ] || { echo "Not on main. Run: git switch main"; exit 1; }
git diff --quiet HEAD || { echo "Local changes in tracked files. Commit or stash them first."; exit 1; }
git fetch -q origin main
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)

# plugin/.installed holds the commit of the last install. Missing or unknown = rebuild to be safe.
MARK=plugin/.installed
SRC="plugin/WaveShare.cpp plugin/Info.plist plugin/build.sh"
LAST=$(cat "$MARK" 2>/dev/null || true)
PLUGIN=0
if [ -z "$LAST" ] || ! git cat-file -e "$LAST^{commit}" 2>/dev/null || ! git diff --quiet "$LAST" "$NEW" -- $SRC; then PLUGIN=1; fi

if [ $PLUGIN = 1 ] && pgrep -x VirtualDJ >/dev/null; then
  echo "The plugin needs a rebuild. Quit VirtualDJ, then run tools/update.sh again. Nothing was changed."
  exit 1
fi

git merge -q --ff-only origin/main
[ "$OLD" = "$NEW" ] || git log --oneline "$OLD..$NEW"

if [ $PLUGIN = 1 ]; then
  plugin/build.sh
  echo "$NEW" > "$MARK"
fi

echo
changed() { ! git diff --quiet "$OLD" "$NEW" -- "$@"; }
[ $PLUGIN = 1 ] && echo "VirtualDJ: plugin updated, start VirtualDJ and switch WaveShare on." || echo "VirtualDJ: no restart needed."
if changed server/server.js; then
  pgrep -f server/server.js >/dev/null && echo "Server: RESTART needed (Ctrl+C, then node server/server.js)." \
    || echo "Server: updated, start it with node server/server.js."
else
  echo "Server: no restart needed."
fi
changed server/index.html && echo "Dashboard: reload the page on every device."
[ "$OLD" = "$NEW" ] && echo "Already up to date."
exit 0
