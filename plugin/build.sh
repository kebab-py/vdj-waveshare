#!/bin/sh
# Builds WaveShare.bundle (deck effect) and WaveShareClock.bundle (master effect), universal arm64 + x86_64,
# and installs both into VirtualDJ. Close VirtualDJ first.   ./build.sh --no-install   builds only (used by CI).
set -e
cd "$(dirname "$0")"
./fetch-sdk.sh
for N in WaveShare WaveShareClock; do
  B=$N.bundle
  rm -rf $B && mkdir -p $B/Contents/MacOS
  sed -e "s/>WaveShare</>$N</" -e "s/sk.kebab.waveshare</sk.kebab.$(echo $N | tr A-Z a-z)</" Info.plist > $B/Contents/Info.plist
  clang++ -std=c++17 -O2 -arch arm64 -arch x86_64 -bundle -fvisibility=hidden \
    -I sdk -framework CoreFoundation \
    -o $B/Contents/MacOS/$N $N.cpp
  codesign --force --sign - $B
done
[ "$1" = "--no-install" ] && { echo "Built: plugin/WaveShare.bundle plugin/WaveShareClock.bundle"; exit 0; }
# VirtualDJ 2021+ keeps its home folder in Library; older versions in Documents.
HOME_VDJ="$HOME/Library/Application Support/VirtualDJ"
[ -d "$HOME_VDJ" ] || HOME_VDJ="$HOME/Documents/VirtualDJ"
[ -d "$HOME_VDJ" ] || { echo "VirtualDJ home folder not found"; exit 1; }
DEST="$HOME_VDJ/PluginsMacArm/SoundEffect"
mkdir -p "$DEST"
for B in WaveShare.bundle WaveShareClock.bundle; do rm -rf "$DEST/$B" && cp -R $B "$DEST/"; done
echo "Installed: $DEST/WaveShare.bundle and WaveShareClock.bundle"
