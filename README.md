# VDJ WaveShare

Live VirtualDJ waveforms for your lighting operator. Open a browser on any device in the same network and see what the DJ plays: waveform, BPM, time left, loops and energy, for up to 4 decks.

Works with streaming (TIDAL), since the plugin reads the decoded audio inside VirtualDJ. No files, no audio leaves the DJ laptop.

![Dashboard with 4 decks](docs/screenshot.png)

<sub>Screenshot with simulated data.</sub>

## Features

- 3-band waveform (bass, mids, highs), 100 columns per second
- Zoom from 2 to 64 seconds, by buttons, mouse wheel or pinch
- Two views: MIX (bands overlaid) and PÁSMA (bands in separate lanes)
- Energy strip: dark for breakdowns, bright green for drops
- BPM as the largest number, plus key, tempo and time left
- Loop region with length in beats
- 2 or 4 decks, colored like VirtualDJ: red, blue, green, orange
- Pre-load: a track on a paused deck gets scanned while another deck plays, or anytime with WaveShare Clock on the master
- Phone, tablet and desktop layouts
- No cloud, no accounts, no npm packages

## Requirements

| Part | Needs |
| --- | --- |
| DJ laptop | macOS on Apple Silicon or Intel, VirtualDJ 8 / 2021+, Xcode Command Line Tools (`xcode-select --install`), Node.js 18+ |
| Lighting operator | Any modern browser in the same network |

Windows is not supported yet. See [Contributing](CONTRIBUTING.md).

## Quick start

On the DJ laptop:

```sh
git clone https://github.com/kebab-py/vdj-waveshare.git
cd vdj-waveshare

# 1. Close VirtualDJ, then build and install the plugin
plugin/build.sh

# 2. Start the server
node server/server.js
```

3. Open VirtualDJ. In the effect list of deck 1 and deck 2, switch on WaveShare. On the master, switch on WaveShare Clock: it lets WaveShare load tracks while every deck is paused, like the first track of a set.
4. The server prints addresses like `http://192.168.1.20:7777`. Open one on the lighting operator's device.

Keep the server window open during the set. Close VirtualDJ before you stop the server.

## How it works

```
VirtualDJ ─ WaveShare plugin ─▶ UDP :7778 ─▶ server.js ─▶ HTTP/SSE :7777 ─▶ browsers
```

- [Architecture](docs/architecture.md): plugin, server, dashboard, known issues
- [Protocol](docs/protocol.md): UDP packets and HTTP routes

## Development

```
plugin/   WaveShare.cpp (deck effect) and WaveShareClock.cpp (master effect), C++17, build and test scripts
server/   server.js (Node, no dependencies) and index.html (dashboard, single file)
tools/    update.sh: pull main, rebuild plugin if needed; simulate.js: plays audio files as fake decks; udp-test.js: prints raw plugin output
docs/     docs and the project landing page (GitHub Pages)
```

| Task | Command |
| --- | --- |
| Update the DJ laptop to latest main | `tools/update.sh` |
| Test plugin logic without VirtualDJ | `plugin/test.sh` |
| Build without installing | `plugin/build.sh --no-install` |
| Test server and dashboard without VirtualDJ | `node tools/simulate.js --demo` or `node tools/simulate.js a.mp3 b.wav` |
| Inspect plugin output | `node tools/udp-test.js` (server stopped) |
| Check VirtualDJ script queries | `node server/server.js --test "get_bpm"` (needs Network Control) |

Debugging: `server/server.log` lists track changes, finished waveforms, pre-load results and plugin silence. macOS crash reports for VirtualDJ live in `~/Library/Logs/DiagnosticReports`.

Every pull request runs a macOS build and the plugin test in GitHub Actions.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before large changes.

## License

[GPL-3.0](LICENSE). The VirtualDJ SDK headers belong to Atomix Productions and are not part of this repo. `plugin/fetch-sdk.sh` downloads them from virtualdj.com.

Not affiliated with Atomix Productions or VirtualDJ.
