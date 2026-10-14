# Protocol

Two links. The plugin talks UDP to the server on the same Mac. The server talks HTTP and Server-Sent Events (SSE) to browsers on the LAN.

## UDP: plugin to server

Port `127.0.0.1:7778`. Little-endian. One sender thread per deck, 20 ticks per second.

### Header, 12 bytes

| Bytes | Field | Type | Notes |
| --- | --- | --- | --- |
| 0-3 | magic | `char[4]` | `VDJW` |
| 4 | version | `uint8` | `1` |
| 5 | type | `uint8` | 1 position, 2 waveform, 3 metadata, 4 log |
| 6 | deck | `uint8` | 1-4, from `get_deck` |
| 7 | reserved | `uint8` | `0` |
| 8-11 | trackId | `uint32` | Increments on every track change |

### Type 1: position, 28 bytes, every tick

| Bytes | Field | Type |
| --- | --- | --- |
| 12-15 | songPos | `uint32`, samples from track start |
| 16-19 | sampleRate | `uint32` |
| 20-23 | totalBins | `uint32`, track length in columns |
| 24-27 | scannedBins | `uint32`, columns computed so far |

Sent while the deck is paused too. The server uses this to tell "paused" from "plugin off".

### Type 2: waveform, every tick

| Bytes | Field | Type |
| --- | --- | --- |
| 12-15 | binStart | `uint32` |
| 16-17 | binCount | `uint16`, max 400 |
| 18+ | data | `uint8[3 * binCount]`: low, mid, high per column |

New columns go first. Otherwise the sender cycles through the whole track, so a restarted server or a lost packet heals itself.

### Type 3: metadata, every 5th tick

| Bytes | Field | Type |
| --- | --- | --- |
| 12 | flags | `uint8`: bit 0 play, 1 audible, 2 loop, 3 pre-load OK, 4 pre-load off |
| 13-15 | reserved | |
| 16-19 | ageMs | `uint32`, age of the data in the plugin |
| 20-39 | bpm, length s, loopIn s, loopOut s, loopBeats | `float32` × 5 |
| 40+ | title, artist, key | 3 × (`uint8` length + UTF-8 bytes) |
| after key | firstBeat | `int32`, sample position of the song's first beat (beat 0), can be negative |
| +4 | beatLen | `uint32`, samples per beat. `0` = no grid yet |

The beat grid comes from VirtualDJ's `SongPosBeats` and `SongBpm`, read in the deck's own audio calls. A paused deck sends `0` until it plays once, also when WaveShare Clock drives it. Positions are track samples, like `songPos`. Older plugins end the packet after the key, the server then shows no beat lines.

### Type 4: log line

UTF-8 text from byte 12. The server writes it into `server/server.log`.

## Waveform columns

- 100 columns per second of track.
- 3 bands from two one-pole low-pass filters: below 200 Hz, 200-2500 Hz, above 2500 Hz.
- Value = RMS of the band × gain (1, 1.5, 2.5) × `SCALE` (2) × 255, clamped to 255.
- The browser rescales each track to its 98th percentile.

## HTTP: server to browser

Port `7777`.

| Route | Returns |
| --- | --- |
| `GET /` | `server/index.html` |
| `GET /events` | SSE. Default event: full state JSON, 10 per second, `grid: {first, beat}` in seconds per deck (`null` without a grid). Event `wave`: `{deck, rev, start, data}` with changed columns as base64 |
| `GET /wave/:deck` | Binary: `total × 3` bytes of columns, then `total` bytes of "computed" flags. Header `X-Rev` |

A browser fetches `/wave/:deck` when `rev` changes, then applies `wave` events on top.
