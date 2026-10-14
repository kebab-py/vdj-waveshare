#!/bin/sh
# Runs the plugin logic against a simulated VirtualDJ (no VirtualDJ needed).
set -e
cd "$(dirname "$0")"
./fetch-sdk.sh
clang++ -std=c++17 -O1 -g -fsanitize=address,undefined -I sdk -framework CoreFoundation \
  -o /tmp/waveshare_host_test host_test.cpp
/tmp/waveshare_host_test        # pre-load works
/tmp/waveshare_host_test x      # pre-load must switch itself off
/tmp/waveshare_host_test clock  # all decks paused, master clock drives them
