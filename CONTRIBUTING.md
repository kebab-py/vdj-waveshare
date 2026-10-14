# Contributing

Thanks for helping. This project runs live during DJ sets, so stability beats features.

## Workflow

1. Pick or open an issue. Comment on it so nobody does the same work twice.
2. Create a branch from `main`: `fix/pause-playhead`, `feat/beat-grid`, `docs/protocol`.
3. Keep pull requests small. One topic per PR.
4. Open the PR early as a draft if you want feedback.
5. CI must pass. One review from a maintainer, then squash merge.

Collaborators push branches to this repo. Everyone else forks.

## Test before you open a PR

CI builds the plugin and runs `plugin/test.sh`. It has no VirtualDJ, so changes to the plugin or server also need a real test:

- [ ] `plugin/test.sh` passes
- [ ] Plugin built and loaded in VirtualDJ, both decks
- [ ] Play, pause, seek, load a new track, loop in/out
- [ ] Dashboard on a second device in the same network
- [ ] `server/server.log` shows no `POZOR` lines

Write in the PR what you tested and on which VirtualDJ version.

## Rules for the plugin

The plugin runs inside the DJ's audio engine. A bug here stops the music.

- Audio thread: no allocation, no blocking locks, no file I/O, no sleeping. Use `try_lock` or atomics.
- Sender thread: reads plugin memory only. Never call VirtualDJ from it.
- VirtualDJ script queries go through `q()` / `qs()`. They add `deck N`, without it VirtualDJ answers for the wrong deck.
- Never query `get_loaded_song 'filepath'`. It crashes VirtualDJ on TIDAL tracks.
- New behavior with risk gets a switch at the top of `WaveShare.cpp` (like `PRELOAD`).
- Logic changes get a case in `host_test.cpp`.

## Rules for server and dashboard

- No npm dependencies, no build step. `server.js` runs with plain `node`, `index.html` is one file.
- Do not reintroduce frequent Network Control polling. It crashed VirtualDJ on quit.
- Test the dashboard at phone, tablet and desktop width.

## Protocol changes

Change `docs/protocol.md` in the same PR. Incompatible changes bump the version byte.

## Style

- Comments and docs in English. User-facing text (dashboard, `server.log` lines) stays Slovak.
- Prefer the simplest working solution. Mark deliberate shortcuts with a `ponytail:` comment naming the limit.
- Commit messages: imperative, short. `Fix playhead jump on pause`.

## Labels

| Label | Meaning |
| --- | --- |
| `plugin` | C++ VirtualDJ plugin |
| `server` | Node server |
| `dashboard` | Browser UI |
| `bug` / `enhancement` | Type |
| `good first issue` | Small, well described, good start |
| `needs-vdj-test` | Needs a test with real VirtualDJ |

## Conduct

Be kind, be specific, assume good intent. Critique code, not people. Maintainers remove comments or contributors who don't follow this.
