#!/bin/sh
# Runs the probe against a simulated VirtualDJ and checks its UDP log lines.
set -e
cd "$(dirname "$0")"
../fetch-sdk.sh >/dev/null
clang++ -std=c++17 -O1 -g -fsanitize=undefined -I ../sdk -framework CoreFoundation -o /tmp/waveshare_probe_test host_test.cpp
node -e "
const s = require('dgram').createSocket('udp4'), got = [];
s.on('message', b => got.push(b.toString('utf8', 12)));
s.bind(7778, '127.0.0.1', () => require('child_process').execFile('/tmp/waveshare_probe_test', (e, out) => {
  s.close(); console.log(out.trim()); got.forEach(l => console.log(l));
  if (e || !got.some(l => /^PROBE deck=0 calls\/s=50\+ \| d1 PLAY .*\| d2 stop len=177 bpm=124\.0/.test(l))) process.exit(1);
}));"
