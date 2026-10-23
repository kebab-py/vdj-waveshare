#!/bin/sh
# Runs the plugin logic against a simulated VirtualDJ (no VirtualDJ needed).
set -e
cd "$(dirname "$0")"
./fetch-sdk.sh
# ponytail: the ASan runtime of Apple clang before 21 (Xcode 17) hangs at startup on macOS 26, before any
# test code runs. Fixed in clang 21 (Xcode 27). Only that combination drops ASan. Override: SAN=... plugin/test.sh
if [ -z "$SAN" ]; then
  SAN=address,undefined
  OS=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  CLANG=$(clang++ --version | sed -n 's/.*clang version \([0-9]*\).*/\1/p' | head -1)
  [ "${OS:-0}" -ge 26 ] && [ "${CLANG:-0}" -lt 21 ] && { SAN=undefined; echo "macOS 26 + clang $CLANG: running without ASan"; }
fi
clang++ -std=c++17 -O1 -g -fsanitize=$SAN -I sdk -framework CoreFoundation \
  -o /tmp/waveshare_host_test host_test.cpp
/tmp/waveshare_host_test        # pre-load works
/tmp/waveshare_host_test x      # pre-load must switch itself off
/tmp/waveshare_host_test clock  # all decks paused, master clock drives them
