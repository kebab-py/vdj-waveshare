// VirtualDJ waveform for the lighting operator. Node 18+, no npm packages.
// Run: node server.js        Check VirtualDJ queries: node server.js --test
// The WaveShare plugin sends waveform and metadata over UDP (plugin/). Network Control is an optional fallback, off.
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG = {
  // Network Control off: its threads crashed VirtualDJ on quit (crashes 13 Oct 21:35, 21:59, 22:57).
  // The WaveShare plugin sends the data. To switch on: 'http://127.0.0.1:8080' (port of the Network Control plugin).
  vdjUrl: '',
  vdjPassword: '',                 // if you set a password in the plugin
  port: 7777,                      // the lighting operator connects here
  udpPort: 7778,                   // the WaveShare plugin sends here
  decks: [1, 2, 3, 4],             // decks 3 and 4 show after switching in the browser
  publishMs: 100,                  // state to browsers 10 times per second
  fallbackMs: 1000,                // Network Control only as a fallback when the plugin has no fresh data

};

// The main data source is the WaveShare plugin (UDP). Network Control is only a fallback when no deck plays:
// many parallel HTTP requests crashed VirtualDJ (crash 13 Oct in the NetworkSocket thread when closing the window).
// So: one request at a time, at most once per second, only for decks without fresh plugin data.
// Never add get_loaded_song 'filepath': it crashes VirtualDJ on a TIDAL track.
const FIELDS = { title: 'get_title', pos: 'get_position', playing: 'play', audible: 'is_audible', bpm: 'get_bpm' };
const ONCE = { artist: 'get_artist', key: 'get_key', length: 'get_songlength' };   // only when the track changes
const LOOP = { loopOn: 'loop', loopIn: 'get_loop_in_time', loopOut: 'get_loop_out_time', loopBeats: 'get_active_loop' };

async function q(deck, script) {
  let url = `${CONFIG.vdjUrl}/query?script=${encodeURIComponent(`deck ${deck} ${script}`)}`;
  if (CONFIG.vdjPassword) url += `&bearer=${encodeURIComponent(CONFIG.vdjPassword)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok ? (await r.text()).trim() : null;
  } catch { return null; }
}

const num = v => (v == null || v === '' || isNaN(v) ? null : parseFloat(v));
const bool = v => (/^(true|on|yes|1)$/i.test(v) ? true : /^(false|off|no|0)$/i.test(v) ? false : null);

function parse(raw) {
  const o = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'pos') { const p = num(v); o.pos = p > 1 ? p / 100 : p; } // ponytail: accepts both 0-1 and 0-100
    else if (k === 'playing' || k === 'audible') o[k] = bool(v);
    else if (k === 'bpm' || k === 'length' || k === 'loopIn' || k === 'loopOut' || k === 'loopBeats') o[k] = num(v);
    else if (k === 'loopOn') o[k] = v;
    else o[k] = v || '';
  }
  return o;
}

async function poll(deck, fields) {               // one after another, never several requests at once
  const o = {};
  for (const [k, s] of Object.entries(fields)) o[k] = await q(deck, s);
  return o;
}

// state goes to browsers 10 times per second; the waveform (wave) separately, changed columns only
// Event log in server.log next to the server: track changes, plugin silence, pre-load. Claude reads it too.
const LOG = path.join(__dirname, 'server.log');
function log(...a) {
  const d = new Date(), local = new Date(d - d.getTimezoneOffset() * 60000);   // local time, not UTC
  const line = `${local.toISOString().slice(0, 23).replace('T', ' ')} ${a.join(' ')}`;
  console.log(line);
  fs.appendFile(LOG, line + '\n', () => {});
}
const seen = {};                                   // last logged state per deck
function watch(d, key, val, msg) {
  const k = d + key;
  if (seen[k] === val) return;
  seen[k] = val;
  log(`deck ${d}`, msg ?? `${key}=${JSON.stringify(val)}`);
}

const state = { online: false, decks: {} };
const wave = {};
for (const d of CONFIG.decks) {
  state.decks[d] = { rev: 0, total: 0, scanned: 0 };
  wave[d] = { id: null, bins: new Uint8Array(0), have: new Uint8Array(0), sec: null, at: 0, rate: 1, hist: [], meta: null };
}
const clients = new Set();

function send(msg) { for (const res of clients) res.write(msg); }
function publish() { send(`data: ${JSON.stringify(state)}\n\n`); }

// ponytail: guard against overlapping runs if VirtualDJ answers slowly
function loop(ms, fn) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } finally { busy = false; }
  }, ms);
}

const fresh = w => w.meta && performance.now() - w.meta.t < 1500;   // the deck's audio thread (or another playing deck's, or the master clock) collects data
const alive = w => performance.now() - w.at < 1500;                   // plugin runs (positions arrive while paused too)
let httpOnline = false;

// State for the browser. When a deck is paused and nothing calls the plugin, the metadata gets stale,
// but positions from the plugin keep coming. Then deck = pause, last metadata, position from the plugin.
loop(CONFIG.publishMs, async () => {
  const now = performance.now();
  let online = httpOnline;
  for (const d of CONFIG.decks) {
    const s = state.decks[d], w = wave[d], m = w.meta;
    const mode = fresh(w) ? 'live' : alive(w) && m ? 'pause' : 'off';
    watch(d, 'mode', mode, { live: 'plugin posiela údaje', pause: 'deck stojí (plugin beží, VDJ ho nevolá)', off: 'plugin neposiela nič (efekt vypnutý alebo VDJ zavreté)' }[mode]);
    if (mode !== 'off') online = true;
    if (m && mode !== 'off') {
      watch(d, 'title', m.title);
      watch(d, 'preload', m.preload);
      watch(d, 'loop', m.loop ? `${m.loop.in.toFixed(2)}-${m.loop.out.toFixed(2)}s ${m.loop.beats}b` : null);
      Object.assign(s, { title: m.title, artist: m.artist, key: m.key, bpm: m.bpm || null, length: m.len || null,
        playing: mode === 'live' && m.playing, audible: m.audible, loop: m.loop, grid: m.grid });
    }
    if (mode === 'off' && !httpOnline) s.playing = false;           // we know nothing: stop the playhead, don't guess
    // While playing: exact position from the plugin, extrapolated to the send time.
    if (s.playing && w.sec != null && now - w.at < 300) { s.sec = w.sec + w.rate * (now - w.at) / 1000; s.rate = w.rate; }
    else if (w.sec != null && mode !== 'off') { s.sec = w.sec; s.rate = 0; }
    else if (httpOnline) { s.sec = (s.pos || 0) * (s.length || 0); s.rate = s.playing ? 1 : 0; }
    else s.rate = 0;                                                  // the last known position stays
  }
  state.online = online;
  publish();
});

// Network Control fallback: only decks the plugin reports nothing about (e.g. when nothing plays)
loop(CONFIG.fallbackMs, async () => {
  if (!CONFIG.vdjUrl) return;
  let ok = false;
  for (const d of CONFIG.decks) {
    if (fresh(wave[d])) continue;
    const s = state.decks[d];
    const r = parse(await poll(d, FIELDS));
    if (r.title !== null && r.title !== undefined) ok = true;
    if (!r.title) { Object.assign(s, { title: '', artist: '', key: '', bpm: null, length: null, playing: false, audible: false, loop: null, pos: 0 }); continue; }
    if (r.title !== s.title || !s.length) Object.assign(r, parse(await poll(d, ONCE)));
    const L = parse(await poll(d, LOOP));
    r.loop = bool(L.loopOn) ? { in: num(L.loopIn) / 1000, out: num(L.loopOut) / 1000, beats: num(L.loopBeats) } : null;
    Object.assign(s, r);
  }
  httpOnline = ok;
});

// UDP from the WaveShare plugin. Format: docs/protocol.md.
const udp = dgram.createSocket('udp4');
udp.on('message', b => {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'VDJW' || b[4] !== 1) return;
  const deck = b[6], id = b.readUInt32LE(8), w = wave[deck], s = state.decks[deck];
  if (!w) return;
  if (b[5] === 1 && b.length >= 28) {
    const [pos, sr, total, scanned] = [12, 16, 20, 24].map(o => b.readUInt32LE(o));
    if (id !== w.id || total !== w.have.length) {          // new track: empty array, the browser fetches /wave
      w.id = id; w.bins = new Uint8Array(total * 3); w.have = new Uint8Array(total);
      s.rev++; s.total = total;
      // Count only tracks with a length: a load passes through 0 s ids (empty deck, title before length).
      w.revTimes = (w.revTimes || []).filter(t => Date.now() - t < 10000).concat(total ? Date.now() : []);
      log(`deck ${deck}`, `nová skladba #${id}, ${(total / 100).toFixed(0)} s` + (w.revTimes.length > 3 ? ` POZOR: ${w.revTimes.length}x za 10 s, plugin si mýli skladbu` : ''));
    }
    // playback speed (pitch) from the last ~1 s; a jump in the track clears the history
    const sec = pos / (sr || 44100), now = performance.now(), h = w.hist;
    const last = h.at(-1);
    if (last && (sec === last[1] || Math.abs(sec - (last[1] + w.rate * (now - last[0]) / 1000)) > 0.5)) h.length = 0; // pause or jump
    h.push([now, sec]);
    while (h.length > 2 && now - h[0][0] > 1000) h.shift();
    if (now - h[0][0] > 200) w.rate = (sec - h[0][1]) / (now - h[0][0]) * 1000;
    w.sec = sec; w.at = now; w.sr = sr || 44100;
    if (total && scanned === total && w.doneId !== id) { w.doneId = id; log(`deck ${deck}`, `waveform skladby #${id} hotový`); }
    s.scanned = scanned;
  } else if (b[5] === 3 && b.length >= 43) {
    let o = 40;
    const str = () => { const n = b[o]; const t = b.toString('utf8', o + 1, o + 1 + n); o += 1 + n; return t; };
    const f = i => b.readFloatLE(20 + 4 * i), flags = b[12];
    const title = str(), artist = str(), key = str();
    // beat grid after the strings (older plugins stop here): beat 0 and beat length in samples
    const sr = w.sr || 44100, gb = o + 8 <= b.length ? b.readUInt32LE(o + 4) : 0;
    const grid = gb ? { first: b.readInt32LE(o) / sr, beat: gb / sr } : null;
    w.meta = {
      grid,
      t: performance.now() - b.readUInt32LE(16), title, artist, key,
      playing: !!(flags & 1), audible: !!(flags & 2), bpm: f(0), len: f(1),
      preload: flags & 8 ? 'ok' : flags & 16 ? 'vypnutý (VDJ vracia audio iného decku)' : 'neoverený',
      loop: flags & 4 && f(3) > f(2) ? { in: f(2), out: f(3), beats: f(4) } : null,
    };
  } else if (b[5] === 4) {
    log(`deck ${deck} plugin:`, b.toString('utf8', 12));
  } else if (b[5] === 2 && b.length >= 18 && id === w.id) {
    const start = b.readUInt32LE(12), n = Math.min(b.readUInt16LE(16), w.have.length - start, (b.length - 18) / 3 | 0);
    if (n <= 0) return;
    const data = b.subarray(18, 18 + n * 3);
    const old = w.bins.subarray(start * 3, (start + n) * 3);
    if (w.have[start] && w.have[start + n - 1] && Buffer.compare(data, old) === 0) return; // repeated ring, nothing new
    old.set(data); w.have.fill(1, start, start + n);
    send(`event: wave\ndata: ${JSON.stringify({ deck, rev: s.rev, start, data: data.toString('base64') })}\n\n`);
  }
});

function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  // whole waveform for a browser that connects later: total×3 B columns, then total B "computed" flags
  const m = url.pathname.match(/^\/wave\/(\d+)$/);
  const w = m && wave[m[1]];
  if (w) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Rev': state.decks[m[1]].rev, 'Cache-Control': 'no-store' });
    return res.end(Buffer.concat([w.bins, w.have]));
  }
  res.writeHead(404);
  res.end();
}

if (process.argv.includes('--test')) {
  (async () => {
    // node server.js --test                 → all queries
    // node server.js --test "get_time"      → only the given queries
    const custom = process.argv.slice(process.argv.indexOf('--test') + 1);
    const list = custom.length ? custom.map(s => ['>', s]) : Object.entries({ ...FIELDS, ...ONCE, ...LOOP });
    console.log(`Pýtam sa ${CONFIG.vdjUrl}, deck 1 (načítaj skladbu a pusti ju):\n`);
    for (const [k, s] of list) {
      console.log(k.padEnd(8), s.padEnd(28), JSON.stringify(await q(1, s)));
    }
    process.exit();
  })();
} else {
  udp.bind(CONFIG.udpPort, '127.0.0.1');
  log('server štart', CONFIG.vdjUrl ? `Network Control: ${CONFIG.vdjUrl}` : 'Network Control vypnutý');
  http.createServer(serve).listen(CONFIG.port, () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(i => (i.family === 'IPv4' || i.family === 4) && !i.internal).map(i => i.address);
    console.log('Osvetľovač otvorí v prehliadači:');
    for (const ip of ips) console.log(`  http://${ip}:${CONFIG.port}`);
    console.log(`Lokálne: http://localhost:${CONFIG.port}`);
  });
}
