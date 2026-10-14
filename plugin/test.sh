#!/bin/sh
# Runs the plugin logic against a simulated VirtualDJ (no VirtualDJ needed).
set -e
cd "$(dirname "$0")"
./fetch-sdk.sh
# ponytail: sanitizer runtimes (ASan, TSan) hang or crash at startup on macOS 26 with Xcode 17 clang,
# before any test code runs. There only UBSan runs; CI on older macOS keeps ASan. Override: SAN=... plugin/test.sh
if [ -z "$SAN" ]; then
  SAN=address,undefined
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ] && { SAN=undefined; echo "macOS 26+: running without ASan"; }
fi
clang++ -std=c++17 -O1 -g -fsanitize=$SAN -I sdk -framework CoreFoundation \
  -o /tmp/waveshare_host_test host_test.cpp
/tmp/waveshare_host_test        # pre-load works
/tmp/waveshare_host_test x      # pre-load must switch itself off
/tmp/waveshare_host_test clock  # all decks paused, master clock drives them
