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
- Cable or Wi-Fi: serves on every adapter, or pick one with `--iface`
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

## Cable or Wi-Fi

By default the server listens on every adapter at once: cable, Wi-Fi and `localhost`. The console prints one address per adapter with its type. Open the cable address on the lighting device when a cable is connected, the Wi-Fi address when not. Nothing switches on its own, so no browser gets dropped.

Cable setup: connect the DJ laptop and the lighting PC or tablet with an Ethernet cable (USB or Thunderbolt adapter on the Mac). Both sides get a `169.254.x.x` address on their own, no router needed.

```sh
node server/server.js --list          # adapters: en0 Wi-Fi, en5 cable (USB 10/100/1000 LAN), ...
node server/server.js                 # default: every adapter, localhost works
node server/server.js --iface en5     # only this adapter, waits until it has an address
node server/server.js --iface auto    # cable if it has an address, else Wi-Fi
```

`--iface` takes `all`, `auto`, the adapter name, its IP or part of the port name (`--iface usb`). Set `iface` in `CONFIG` in `server.js` to make it permanent. With one adapter, `localhost` does not answer and the dashboard status shows `KÁBEL` or `WI-FI`.

`auto` checks every 2 seconds and moves the server when the cable gets plugged in or pulled out. **A switch drops every connected browser**, and it does not reconnect by itself: open the new address shown in the console. Any port that is not Wi-Fi counts as cable (dock, club Ethernet, phone USB tethering), and a flaky cable makes it flip. Use `auto` only when you know the setup.

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
tools/    update.sh: pull main, rebuild plugin if needed; udp-test.js: prints raw plugin output
docs/     docs and the project landing page (GitHub Pages)
```

| Task | Command |
| --- | --- |
| Update the DJ laptop to latest main | `tools/update.sh` |
| Test plugin logic without VirtualDJ | `plugin/test.sh` |
| Build without installing | `plugin/build.sh --no-install` |
| Inspect plugin output | `node tools/udp-test.js` (server stopped) |
| Check VirtualDJ script queries | `node server/server.js --test "get_bpm"` (needs Network Control) |

Debugging: `server/server.log` lists track changes, finished waveforms, pre-load results and plugin silence. macOS crash reports for VirtualDJ live in `~/Library/Logs/DiagnosticReports`.

Every pull request runs a macOS build and the plugin test in GitHub Actions.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before large changes.

## License

[GPL-3.0](LICENSE). The VirtualDJ SDK headers belong to Atomix Productions and are not part of this repo. `plugin/fetch-sdk.sh` downloads them from virtualdj.com.

Not affiliated with Atomix Productions or VirtualDJ.
