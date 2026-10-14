# Architecture

```
 VirtualDJ (Mac)                         same Mac                     LAN
┌─────────────────────────┐   UDP    ┌──────────────┐   HTTP + SSE   ┌──────────────────┐
│ deck 1  WaveShare plugin │ ───────▶ │  server.js   │ ─────────────▶ │ browser / tablet │
│ deck 2  WaveShare plugin │  :7778   │  (Node 18+)  │     :7777      │ (lighting op)    │
└─────────────────────────┘          └──────────────┘                └──────────────────┘
```

Audio never leaves VirtualDJ. Only the envelope goes out: 3 bytes per 10 ms.

## Plugin: `plugin/WaveShare.cpp`

A VirtualDJ 8 Buffer DSP effect (`IVdjPluginBufferDsp8`). Only this plugin type receives the decoded track and reads samples at any position, which makes it work with streaming (TIDAL) where no file exists on disk.

One instance per deck. Each instance:

1. Passes audio through untouched in `OnGetSongBuffer`.
2. Scans the track in 8192-sample chunks, starting at the playhead, then wraps to the start. A 4-minute track takes about 15 s.
3. Collects metadata (title, BPM, key, loop) 4 times per second through VirtualDJ script queries.
4. Runs a sender thread. The thread reads plugin memory only and never calls VirtualDJ.

### Pre-load

VirtualDJ calls the plugin only while its deck plays. To scan a track on a paused deck, the playing deck's audio thread also works for the paused deck's instance.

Lessons from testing:

- Script queries without a deck prefix return data of the calling deck. All queries go through `q()` / `qs()`, which add `deck N`.
- Before pre-load scans audio, `preloadCheck()` compares 1024 frames from both decks. Identical audio means VirtualDJ returns the caller's audio, and pre-load switches itself off. The result goes to `server.log`.
- Confirmed on real VirtualDJ on 13 Oct 2026: `server.log` showed `plugin: preload OK` and a paused deck's waveform finished without touching it.
- When no deck plays, no deck effect runs. WaveShare Clock covers that case, see below.

### Master clock: `plugin/WaveShareClock.cpp`

A second, tiny plugin (`IVdjPluginDsp8`) for the master effect slot. VirtualDJ calls master effects about 100 times per second even while every deck is paused (measured with a probe on 14 Oct 2026, `deck N` queries returned the paused deck's length and BPM). Confirmed working on real VirtualDJ the same day.

- Its own thread finds the loaded WaveShare bundle among the process images (`dlopen` with `RTLD_NOLOAD`, which also keeps it loaded) and looks up `WaveShareClockTick`.
- The master audio thread calls `WaveShareClockTick()`. It ticks every deck whose own audio thread has been idle for 200 ms, exactly like pre-load: metadata, track detection, scanning.
- Switch: `MASTER_CLOCK` in `WaveShare.cpp`. If the pre-load audio check fails (`-1`), the clock stops scanning audio too.
- The first tick writes `plugin: master clock: bezi` to `server.log`.

## Server: `server/server.js`

Node 18+, no npm packages.

- Merges UDP packets per deck. A new `trackId` resets the column array and bumps `rev`.
- Computes playback speed (pitch) from the last second of positions and extrapolates the position to send time.
- Deck states: `live` (fresh metadata), `pause` (positions arrive, metadata stale), `off` (nothing arrives).
- Writes events to `server/server.log` with local date and time: track changes, finished waveforms, pre-load result, loops, plugin silence.
- Network Control fallback exists but is off (`vdjUrl: ''`). See Known issues.
- Network adapter (`iface`, `--iface`): `all` (default) listens on every adapter once, as before. Opt-in `auto` serves on the cable if it has an IPv4 address, else on Wi-Fi, one adapter name or IP serves only there. Both check every 2 s; a changed address restarts the HTTP server on it and closes all connections, so browsers must open the new address. Cable = any macOS hardware port that is not Wi-Fi (`networksetup -listallhardwareports`, read again only when the adapter list changes). VPN and virtual adapters come last.

## Dashboard: `server/index.html`

Single file, no build step, no libraries.

- Canvas detail view with zoom (2-64 s), overview with energy strip, loop region.
- Views: MIX (bands overlaid) and PÁSMA (bands in separate lanes).
- 2 or 4 decks, deck colors 1 red, 2 blue, 3 green, 4 orange.
- Smooth playhead: small errors fade out over time, large ones (seek, pause, new track) snap.
- Settings persist in `localStorage`.

## Known issues

| Issue | Status |
| --- | --- |
| Network Control plugin crashes VirtualDJ on quit (`std::terminate` in a `NetworkSocket` thread, 3 crash reports on 13 Oct 2026) | Server no longer uses it |
| `get_loaded_song 'filepath'` crashes VirtualDJ on a TIDAL track | Never used |
| VirtualDJ wiki lists `Documents/VirtualDJ/PluginsArm` as plugin folder | Wrong on current versions. Real path: `~/Library/Application Support/VirtualDJ/PluginsMacArm/SoundEffect` |
| Units of `get_loop_in_time` | Assumed ms, not verified with pitch ≠ 0 |
| `SCALE` in the plugin | Set by eye |
| Cable detection on macOS (`--iface auto`) | By port name. A dock, club Ethernet or a phone tethered over USB counts as cable |
| A track loaded while no deck plays (typical first track of a set) stayed empty until a deck played. VirtualDJ never calls a paused deck's effect | Fixed by WaveShare Clock on the master (confirmed on real VirtualDJ, 14 Oct 2026). Without it: play any deck, even in the headphones |
| Windows | No build yet |
