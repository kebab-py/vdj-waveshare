#!/bin/sh
# Builds and installs WaveShareProbe.bundle (test only, see MasterProbe.cpp). Close VirtualDJ first.
# Remove after the test: rm -rf "~/Library/Application Support/VirtualDJ/PluginsMacArm/SoundEffect/WaveShareProbe.bundle"
set -e
cd "$(dirname "$0")"
../fetch-sdk.sh
B=WaveShareProbe.bundle
rm -rf $B && mkdir -p $B/Contents/MacOS
sed -e 's/>WaveShare</>WaveShareProbe</' -e 's/sk.kebab.waveshare/sk.kebab.waveshare.probe/' ../Info.plist > $B/Contents/Info.plist
clang++ -std=c++17 -O2 -arch arm64 -arch x86_64 -bundle -fvisibility=hidden \
  -I ../sdk -framework CoreFoundation -o $B/Contents/MacOS/WaveShareProbe MasterProbe.cpp
codesign --force --sign - $B
[ "$1" = "--no-install" ] && { echo "Built: plugin/probe/$B"; exit 0; }
DEST="$HOME/Library/Application Support/VirtualDJ/PluginsMacArm/SoundEffect"
[ -d "$DEST" ] || { echo "$DEST not found"; exit 1; }
rm -rf "$DEST/$B" && cp -R $B "$DEST/"
echo "Installed: $DEST/$B"
