// Simulates the WaveShare plugin: reads audio files and sends the same UDP packets as plugin/WaveShare.cpp,
// so you can test server.js and the dashboard without VirtualDJ. Node 18+, no npm packages.
//
//   node tools/simulate.js track1.mp3 track2.wav     files go to decks 1, 2, ... (extra files queue up per deck)
//   node tools/simulate.js --demo                     two synthetic tracks, no files needed
//   node tools/simulate.js --help                     all options and keys
//
// WAV is read directly. Other formats (mp3, flac, m4a, aiff, ...) need ffmpeg on PATH.
// Start server.js first, or stop it and run tools/udp-test.js to inspect the packets.
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');

// Same constants as plugin/WaveShare.cpp
const BPS = 100;                      // columns per second
const MAXBINS = 30 * 60 * BPS;        // 30 min
const PKT_BINS = 400;                 // columns per waveform packet
const GAIN = [1, 1.5, 2.5];
const SCALE = 2;
const TICK_MS = 50;                   // sender thread: 20 ticks per second
const META_MS = 250;                  // gatherMeta(): at most 4 times per second

const HELP = `Usage: node tools/simulate.js [options] <audio files...>
       node tools/simulate.js --demo [options]

Options
  --demo             Use two synthetic tracks (128 and 124 BPM) instead of files
  --decks N          Number of decks, 1-4 (default: number of files, --demo: 2)
  --paused 2,3       Decks that start paused (default: all play)
  --speed 1.0        Playback speed (pitch) for all decks
  --scan-rate 16     Scan speed, times real time. Plugin: about 16 (4 min track in 15 s). 0 = instant
  --no-preload       Paused decks are not scanned (plugin with PRELOAD = false)
  --loss 0           Fraction of UDP packets to drop, 0-1
  --bpm X            BPM for all tracks (default: estimated from the audio)
  --key X            Key shown on the dashboard (default: empty)
  --rate 44100       Sample rate for files decoded by ffmpeg. WAV files keep their own rate
  --host 127.0.0.1   Server address
  --port 7778        Server UDP port
  --seconds N        Quit after N seconds

Keys (interactive terminal)
  1-4      select deck          space    play / pause
  left     seek -10 s           right    seek +10 s
  up/down  speed +1% / -1%      n        next track in the deck's queue
  l        loop on / off        [ ]      halve / double the loop
  o        plugin on / off      q        quit`;

// ---------- options ----------

function parseArgs(argv) {
  const o = { files: [], demo: false, decks: 0, paused: [], speed: 1, scanRate: 16, preload: true, loss: 0,
    bpm: 0, key: '', rate: 0, host: '127.0.0.1', port: 7778, seconds: 0 };
  const num = (v, name) => { const n = Number(v); if (!isFinite(n)) fail(`${name} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--demo') o.demo = true;
    else if (a === '--decks') o.decks = num(v(), a);
    else if (a === '--paused') o.paused = v().split(',').map(Number);
    else if (a === '--speed') o.speed = num(v(), a);
    else if (a === '--scan-rate') o.scanRate = num(v(), a);
    else if (a === '--no-preload') o.preload = false;
    else if (a === '--loss') o.loss = num(v(), a);
    else if (a === '--bpm') o.bpm = num(v(), a);
    else if (a === '--key') o.key = v();
    else if (a === '--rate') o.rate = num(v(), a);
    else if (a === '--host') o.host = v();
    else if (a === '--port') o.port = num(v(), a);
    else if (a === '--seconds') o.seconds = num(v(), a);
    else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else o.files.push(a);
  }
  if (!o.demo && !o.files.length) { console.log(HELP); process.exit(1); }
  const sources = o.demo ? 2 : o.files.length;
  o.decks = Math.max(1, Math.min(4, o.decks || sources));
  if (o.speed <= 0) fail('--speed must be above 0');
  return o;
}

function fail(msg) { console.error(`simulate: ${msg}`); process.exit(1); }

// ---------- analysis: same math as WaveShare::scanChunk ----------

// Feed mono samples in [-1, 1] (plugin: (L + R) / 2 / 32768). Returns 3 bytes per column: low, mid, high.
// ponytail: one pass from the track start. The plugin starts at the playhead and resets its filters
// when it wraps, so the first column after the wrap differs slightly.
function analyzer(sr) {
  const perBin = Math.floor(sr / BPS);
  const a1 = 1 - Math.exp(-2 * Math.PI * 200 / sr), a2 = 1 - Math.exp(-2 * Math.PI * 2500 / sr);
  let l1 = 0, l2 = 0, acc0 = 0, acc1 = 0, acc2 = 0, inBin = 0, n = 0, frames = 0;
  let bins = new Uint8Array(3 * BPS * 600);
  const col = (acc, k) => Math.min(255, Math.sqrt(acc / perBin) * GAIN[k] * SCALE * 255);  // Uint8Array truncates like the C++ cast
  return {
    push(x) {
      frames++;
      l1 += a1 * (x - l1); l2 += a2 * (x - l2);
      const lo = l1, mi = l2 - l1, hi = x - l2;
      acc0 += lo * lo; acc1 += mi * mi; acc2 += hi * hi;
      if (++inBin < perBin) return;
      if (n < MAXBINS) {
        if (n * 3 + 3 > bins.length) { const b = new Uint8Array(bins.length * 2); b.set(bins); bins = b; }
        bins[n * 3] = col(acc0, 0); bins[n * 3 + 1] = col(acc1, 1); bins[n * 3 + 2] = col(acc2, 2);
        n++;
      }
      acc0 = acc1 = acc2 = 0; inBin = 0;
    },
    finish() {
      const len = frames / sr;                                   // get_songlength, seconds
      const total = Math.min(MAXBINS, Math.floor(len * BPS), n);  // plugin: floor, never past the track end
      return { sr, len, total, bins: bins.slice(0, total * 3) };
    },
  };
}

// ---------- decoding ----------

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Reads PCM or float WAV in blocks. Returns null if the file is not a WAV this parser knows.
function decodeWav(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
    const size = fs.fstatSync(fd).size;
    let off = 12, fmt = null, dataOff = 0, dataLen = 0;
    const ch = Buffer.alloc(8);
    while (off + 8 <= size) {
      fs.readSync(fd, ch, 0, 8, off);
      const id = ch.toString('latin1', 0, 4), len = ch.readUInt32LE(4);
      if (id === 'fmt ') { fmt = Buffer.alloc(Math.min(len, 40)); fs.readSync(fd, fmt, 0, fmt.length, off + 8); }
      if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, size - dataOff); break; }
      off += 8 + len + (len & 1);
    }
    if (!fmt || !dataOff) return null;
    let tag = fmt.readUInt16LE(0);
    const channels = fmt.readUInt16LE(2), sr = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
    if (tag === 0xfffe && fmt.length >= 26) tag = fmt.readUInt16LE(24);   // WAVE_FORMAT_EXTENSIBLE
    const bytes = bits / 8, frameBytes = channels * bytes;
    const read = tag === 1 && bits === 8 ? (b, o) => (b[o] - 128) / 128
      : tag === 1 && bits === 16 ? (b, o) => b.readInt16LE(o) / 32768
      : tag === 1 && bits === 24 ? (b, o) => b.readIntLE(o, 3) / 8388608
      : tag === 1 && bits === 32 ? (b, o) => b.readInt32LE(o) / 2147483648
      : tag === 3 && bits === 32 ? (b, o) => b.readFloatLE(o)
      : tag === 3 && bits === 64 ? (b, o) => b.readDoubleLE(o) : null;
    if (!read || !channels || !sr) return null;
    const an = analyzer(sr), rOff = channels > 1 ? bytes : 0;
    const block = Buffer.alloc(frameBytes * 65536);
    for (let pos = 0; pos + frameBytes <= dataLen;) {
      const got = fs.readSync(fd, block, 0, Math.min(block.length, dataLen - pos), dataOff + pos);
      const frames = Math.floor(got / frameBytes);
      if (!frames) break;
      for (let f = 0, o = 0; f < frames; f++, o += frameBytes) an.push((read(block, o) + read(block, o + rOff)) * 0.5);
      pos += frames * frameBytes;
    }
    return an.finish();
  } finally { fs.closeSync(fd); }
}

// Any format ffmpeg reads, as 16-bit stereo: the same sample format VirtualDJ hands the plugin.
function decodeFfmpeg(file, sr) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 's16le', '-ac', '2', '-ar', String(sr), '-']);
    const an = analyzer(sr);
    let rest = null, err = '';
    ff.stdout.on('data', chunk => {
      const b = rest ? Buffer.concat([rest, chunk]) : chunk;
      const end = b.length - (b.length % 4);
      for (let o = 0; o < end; o += 4) an.push((b.readInt16LE(o) + b.readInt16LE(o + 2)) * (0.5 / 32768));
      rest = end < b.length ? b.subarray(end) : null;
    });
    ff.stderr.on('data', d => { err += d; });
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve(an.finish()) : reject(new Error(err.trim() || `ffmpeg exit ${code}`)));
  });
}

// Title and artist from the file tags (ffprobe), else from "Artist - Title.ext".
function tags(file) {
  let title = '', artist = '';
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title,artist', '-of', 'json', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const t = JSON.parse(out).format?.tags || {};
    const get = k => Object.entries(t).find(([n]) => n.toLowerCase() === k)?.[1] || '';
    title = get('title'); artist = get('artist');
  } catch {}
  if (!title) {
    const base = path.basename(file, path.extname(file)), i = base.indexOf(' - ');
    if (i > 0) { artist = artist || base.slice(0, i); title = base.slice(i + 3); } else title = base;
  }
  return { title, artist };
}

// ponytail: autocorrelation of bass onsets at 100 columns per second. Good enough for 4/4 dance music,
// may land on half or double tempo for other styles. Use --bpm to override.
function onsets(t) {
  const n = t.total, on = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const e = t.bins[i * 3] + 0.5 * t.bins[i * 3 + 1], p = t.bins[i * 3 - 3] + 0.5 * t.bins[i * 3 - 2];
    on[i] = Math.max(0, e - p);
  }
  return on;
}

function estimateBpm(t) {
  const n = t.total, on = onsets(t);
  const K = 8, maxLag = Math.ceil(K * 60 * BPS / 70), ac = new Float64Array(maxLag + 2);
  for (let lag = 20; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += on[i] * on[i + lag];
    ac[lag] = s / (n - lag);
  }
  const at = x => { const i = Math.floor(x), f = x - i; return i + 1 <= maxLag + 1 ? ac[i] * (1 - f) + ac[i + 1] * f : 0; };
  let best = 0, bestScore = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.05) {
    const lag = 60 * BPS / bpm;
    let s = 0;
    for (let k = 1; k <= K; k++) s += at(lag * k);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  return best ? Math.round(best * 10) / 10 : 120;
}

// Time of the first beat in seconds: the phase where the onsets line up best with the tempo.
// ponytail: finds a beat, not the downbeat, so bar lines may sit 1-3 beats off. VirtualDJ knows the real grid.
function estimateFirstBeat(t, bpm) {
  const on = onsets(t), lag = 60 * BPS / bpm;
  let best = 0, bestScore = -1;
  for (let ph = 0; ph < lag; ph += 0.25) {
    let s = 0;
    for (let x = ph; x < on.length - 1; x += lag) { const i = Math.floor(x), f = x - i; s += on[i] * (1 - f) + on[i + 1] * f; }
    if (s > bestScore) { bestScore = s; best = ph; }
  }
  return Math.max(0, best - 1) / BPS;        // onset peaks show up about one column after the beat
}

// ---------- demo tracks ----------

// Kick, bass, hats, clap, pad and a riser, arranged in sections, so the dashboard shows
// breakdowns and drops. Deterministic: same tracks on every run.
function demoTrack(title, bpm, plan, sr) {
  const sections = [];
  for (const [bars, names] of plan) {
    const parts = Object.fromEntries(names.split(' ').map(n => [n, true]));
    for (let b = 0; b < bars; b++) sections.push({ parts, b, bars });
  }
  const spb = 60 / bpm, frames = Math.floor(sections.length * 4 * spb * sr);
  const an = analyzer(sr);
  let seed = 12345, kp = 0, bp = 0, pp = 0, lastBeat = -1, prevNoise = 0;
  const noise = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2147483648 - 1; };
  for (let i = 0; i < frames; i++) {
    const t = i / sr, beatPos = t / spb, beat = Math.floor(beatPos), ph = beatPos - beat, tb = ph * spb;
    const sec = sections[Math.min(sections.length - 1, beat >> 2)], p = sec.parts;
    if (beat !== lastBeat) { lastBeat = beat; kp = 0; }
    const nz = noise(), hp = nz - prevNoise; prevNoise = nz;
    let x = 0;
    if (p.kick) { kp += 2 * Math.PI * (50 + 100 * Math.exp(-tb * 30)) / sr; x += 0.9 * Math.exp(-tb * 18) * Math.sin(kp); }
    bp += 2 * Math.PI * 55 / sr;
    if (p.bass && ph >= 0.5) { const tt = tb - spb / 2; x += (0.35 * Math.sin(bp) + 0.12 * Math.sin(2 * bp)) * (1 - Math.exp(-tt * 40)) * Math.exp(-tt * 3); }
    if (p.hat && ph >= 0.5) x += 0.25 * hp * Math.exp(-(tb - spb / 2) * 60);
    if (p.clap && beat % 2 === 1) x += 0.3 * nz * Math.exp(-tb * 25);
    pp += 2 * Math.PI / sr;
    if (p.pad) x += 0.1 * (1 + 0.3 * Math.sin(t * 1.5)) * (Math.sin(220 * pp) + Math.sin(277.18 * pp) + Math.sin(329.63 * pp));
    if (p.riser) { const r = (sec.b + (beat % 4 + ph) / 4) / sec.bars; x += 0.35 * r * r * hp; }
    an.push(x);
  }
  return { ...an.finish(), title, artist: 'WaveShare Demo', bpm, firstBeat: 0 };
}

const DEMOS = [
  ['Demo Track A', 128, [[16, 'kick hat'], [32, 'kick bass hat clap'], [16, 'pad riser'], [32, 'kick bass hat clap pad'], [16, 'kick hat']]],
  ['Demo Track B', 124, [[8, 'kick hat'], [24, 'kick bass hat'], [8, 'pad riser'], [24, 'kick bass hat clap'], [8, 'pad'], [16, 'kick bass hat clap pad'], [16, 'kick hat']]],
];

async function loadTracks(o) {
  if (o.demo) {
    const sr = o.rate || 44100;
    console.log('Generating demo tracks ...');
    return DEMOS.map(([title, bpm, plan]) => ({ ...demoTrack(title, bpm, plan, sr), key: o.key || '', file: title }));
  }
  const ff = hasFfmpeg(), out = [];
  for (const file of o.files) {
    if (!fs.existsSync(file)) fail(`file not found: ${file}`);
    process.stdout.write(`Reading ${path.basename(file)} ... `);
    let t = !o.rate && /\.wave?$/i.test(file) ? decodeWav(file) : null;
    if (!t) {
      if (!ff) fail(`${file}: needs ffmpeg on PATH (only WAV is read without it)`);
      t = await decodeFfmpeg(file, o.rate || 44100).catch(e => fail(`${file}: ${e.message}`));
    }
    if (!t.total) fail(`${file}: no audio`);
    Object.assign(t, tags(file), { file, key: o.key || '' });
    t.bpm = o.bpm || estimateBpm(t);
    t.firstBeat = estimateFirstBeat(t, t.bpm);
    console.log(`${fmtTime(t.len)}, ${t.bpm} BPM`);
    out.push(t);
  }
  return out;
}

// ---------- decks and the plugin model ----------

// One deck in VirtualDJ plus one WaveShare instance on it. The plugin only learns what VirtualDJ
// tells it while it gets called: while its deck plays, or while another deck plays (pre-load).
function makeDeck(num, queue, o) {
  return {
    num, queue, qi: 0, track: queue[0], pos: 0, playing: !o.paused.includes(num), speed: o.speed, loop: null,
    on: true,
    // plugin memory (WaveShare members)
    p: { hash: null, trackId: 0, gridFirst: 0, gridBeat: 0, playPos: 0, sr: 44100, total: 0, start: 0, scanned: 0, scanAcc: 0, bins: null,
      meta: null, metaAt: 0, log: null, lastLog: '' },
    // sender thread locals
    s: { lastId: -1, sent: 0, ring: 0, tick: 0 },
  };
}

function loadNext(d) {
  d.qi = (d.qi + 1) % d.queue.length;
  d.track = d.queue[d.qi]; d.pos = 0; d.loop = null;
}

function dlog(p, msg) {                         // WaveShare::dlog: one pending line, same line only once
  if (msg === p.lastLog || p.log) return;
  p.lastLog = p.log = msg;
}

// WaveShare::checkTrack. The plugin hashes title and length, so the same file again keeps its trackId.
function checkTrack(d) {
  const p = d.p, t = d.track, hash = `${t.title}|${t.len}|${t.sr}`;
  if (hash === p.hash) return;
  p.hash = hash;
  p.scanned = 0; p.scanAcc = 0;
  p.sr = t.sr; p.total = t.total; p.bins = t.bins;
  const perBin = Math.floor(t.sr / BPS);
  p.start = p.total > 0 ? Math.max(0, Math.min(p.total - 1, Math.floor(p.playPos / perBin))) : 0;
  p.trackId = (p.trackId + 1) >>> 0;
  p.gridBeat = 0;                                // old grid does not fit the new track
}

// OnGetSongBuffer: VirtualDJ fills SongBpm (samples per beat) and SongPosBeats on the deck's own calls only
function readGrid(d) {
  const t = d.track, spb = Math.round(t.sr * 60 / t.bpm);
  d.p.gridBeat = spb;
  d.p.gridFirst = Math.round(t.firstBeat * t.sr);
}

function gatherMeta(d, now, preloadState) {
  const p = d.p;
  if (now - p.metaAt < META_MS) return;
  let flags = 0;
  if (d.playing) flags |= 1 | 2;                // play, is_audible
  if (d.loop) flags |= 4;
  if (preloadState > 0) flags |= 8; else if (preloadState < 0) flags |= 16;
  p.meta = { flags, bpm: d.track.bpm * d.speed, len: d.track.len, loopIn: d.loop ? d.loop.in : 0,
    loopOut: d.loop ? d.loop.out : 0, loopBeats: d.loop ? d.loop.beats : 0,
    title: d.track.title, artist: d.track.artist, key: d.track.key };
  p.metaAt = now;
}

function scan(d, dt, rate) {                    // scanChunk: about 8192 samples per VirtualDJ audio callback
  const p = d.p;
  if (!p.total || p.scanned >= p.total) return;
  if (rate <= 0) { p.scanned = p.total; return; }
  p.scanAcc += rate * BPS * dt;
  const n = Math.floor(p.scanAcc);
  p.scanAcc -= n;
  p.scanned = Math.min(p.total, p.scanned + n);
}

// ---------- UDP packets: same layout as WaveShare::sendLoop ----------

function header(type, deck, id, size) {
  const b = Buffer.alloc(size);
  b.write('VDJW', 0, 'latin1'); b[4] = 1; b[5] = type; b[6] = deck; b[7] = 0;
  b.writeUInt32LE(id >>> 0, 8);
  return b;
}

function positionPacket(d) {
  const p = d.p, b = header(1, d.num, p.trackId, 28);
  b.writeUInt32LE(Math.max(0, Math.floor(p.playPos)) >>> 0, 12); b.writeUInt32LE(p.sr, 16);
  b.writeUInt32LE(p.total, 20); b.writeUInt32LE(p.scanned, 24);
  return b;
}

function wavePacket(d) {
  const p = d.p, s = d.s, tot = p.total, sc = p.scanned;
  if (!(sc > 0 && tot > 0)) return null;
  const fresh = s.sent < sc;                    // new columns before the ring
  const k = fresh ? s.sent : s.ring;
  const b0 = (p.start + k) % tot, n = Math.min(PKT_BINS, sc - k, tot - b0);
  const b = header(2, d.num, p.trackId, 18 + n * 3);
  b.writeUInt32LE(b0, 12); b.writeUInt16LE(n, 16);
  b.set(p.bins.subarray(b0 * 3, (b0 + n) * 3), 18);
  if (fresh) s.sent += n; else if ((s.ring += n) >= sc) s.ring = 0;
  return b;
}

// The plugin copies strings into char[200] (key: char[16]) and cuts bytes, not characters.
function metaPacket(d, now) {
  const m = d.p.meta;
  const strs = [[m.title, 199], [m.artist, 199], [m.key, 15]].map(([s, max]) => Buffer.from(s || '', 'utf8').subarray(0, max));
  const b = header(3, d.num, d.p.trackId, 40 + strs.reduce((a, s) => a + 1 + s.length, 0) + 8);
  b[12] = m.flags;
  b.writeUInt32LE(Math.min(0xffffffff, Math.round(now - d.p.metaAt)), 16);
  [m.bpm, m.len, m.loopIn, m.loopOut, m.loopBeats].forEach((f, i) => b.writeFloatLE(f, 20 + 4 * i));
  let o = 40;
  for (const s of strs) { b[o++] = s.length; s.copy(b, o); o += s.length; }
  b.writeInt32LE(d.p.gridFirst | 0, o); b.writeUInt32LE(d.p.gridBeat >>> 0, o + 4);   // beat grid
  return b;
}

function logPacket(d, msg) {
  const t = Buffer.from(msg, 'utf8').subarray(0, 199), b = header(4, d.num, d.p.trackId, 12 + t.length);
  t.copy(b, 12);
  return b;
}

// ---------- main loop ----------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const tracks = await loadTracks(o);
  const decks = [];
  for (let n = 1; n <= o.decks; n++) {              // file i goes to deck i % decks + 1; spare decks reuse files
    const queue = tracks.length >= o.decks ? tracks.filter((_, i) => i % o.decks === n - 1) : [tracks[(n - 1) % tracks.length]];
    decks.push(makeDeck(n, queue, o));
  }

  const sock = dgram.createSocket('udp4');
  let sentPkts = 0, dropped = 0;
  const send = b => {
    if (!b) return;
    if (o.loss > 0 && Math.random() < o.loss) { dropped++; return; }
    sentPkts++;
    sock.send(b, o.port, o.host);
  };

  let preloadState = 0;                         // g_preloadOk: 0 untested, 1 works, -1 off
  let event = `Sending to ${o.host}:${o.port}`;
  let last = performance.now();
  const startAt = last;

  const step = () => {
    const now = performance.now(), dt = Math.min(0.5, (now - last) / 1000);
    last = now;

    // VirtualDJ: move the playheads
    for (const d of decks) {
      if (!d.playing) continue;
      const sr = d.track.sr;
      d.pos += dt * d.speed * sr;
      if (d.loop && d.pos >= d.loop.out * sr) d.pos = d.loop.in * sr + (d.pos - d.loop.out * sr) % ((d.loop.out - d.loop.in) * sr);
      if (d.pos >= d.track.len * sr) {
        if (d.queue.length > 1) { loadNext(d); event = `Deck ${d.num}: next track, ${d.track.title}`; }
        else { d.pos = 0; event = `Deck ${d.num}: track ended, restart`; }
      }
    }

    // VirtualDJ calls the plugin of every playing deck. With pre-load, a playing deck also ticks the others.
    const playing = decks.filter(d => d.on && d.playing);
    for (const d of playing) {
      d.p.playPos = d.pos; checkTrack(d); readGrid(d); scan(d, dt, o.scanRate); gatherMeta(d, now, preloadState);
    }
    if (o.preload && playing.length) {
      for (const d of decks) {
        if (!d.on || d.playing) continue;
        const caller = playing[0];
        if (preloadState === 0) {                // WaveShare::preloadCheck
          if (caller.track.len < 20 || d.track.len < 20) dlog(caller.p, 'preload test: caka na skladby dlhsie ako 20 s na oboch deckoch');
          else { preloadState = 1; dlog(caller.p, 'preload OK'); }
        }
        if (Math.abs(d.pos - d.p.playPos) > d.track.sr / 10) d.p.playPos = d.pos;
        checkTrack(d);
        if (preloadState === 1) scan(d, dt, o.scanRate);
        gatherMeta(d, now, preloadState);
      }
    }

    // Sender threads: run while the effect is on, also when VirtualDJ does not call the plugin.
    for (const d of decks) {
      if (!d.on) continue;
      const p = d.p, s = d.s;
      if (p.trackId !== s.lastId) { s.lastId = p.trackId; s.sent = s.ring = 0; }
      send(positionPacket(d));
      send(wavePacket(d));
      if (++s.tick % 5 === 0 && p.meta) send(metaPacket(d, now));
      if (p.log) { send(logPacket(d, p.log)); p.log = null; }
    }

    if (o.seconds && now - startAt >= o.seconds * 1000) quit();
  };

  const tty = process.stdin.isTTY && process.stdout.isTTY;
  let sel = 0, drawn = 0;
  const draw = () => {
    const w = process.stdout.columns || 100;
    const lines = [`  ${event}`.slice(0, w)];
    for (const [i, d] of decks.entries()) {
      const t = d.track, p = d.p;
      const scanPct = p.total ? Math.floor(100 * p.scanned / p.total) + '%' : '-';
      const state = !d.on ? 'OFF ' : d.playing ? 'PLAY' : 'STOP';
      const loop = d.loop ? ` loop ${d.loop.beats}b` : '';
      const name = t.artist ? `${t.artist} - ${t.title}` : t.title;
      lines.push(`${i === sel ? '>' : ' '} D${d.num} ${state} ${fmtTime(d.pos / t.sr)} / ${fmtTime(t.len)}  ${(t.bpm * d.speed).toFixed(1)} BPM x${d.speed.toFixed(2)}  scan ${scanPct.padStart(4)}  #${p.trackId}${loop}  ${name}`.slice(0, w));
    }
    lines.push(`  packets ${sentPkts}${o.loss ? `, dropped ${dropped}` : ''}   keys: 1-4 space arrows n l [ ] o q`.slice(0, w));
    let out = drawn ? `\x1b[${drawn}A` : '';
    for (const l of lines) out += `\x1b[2K${l}\n`;
    process.stdout.write(out);
    drawn = lines.length;
  };

  const quit = () => {
    clearInterval(timer); clearInterval(ui);
    if (tty) { draw(); process.stdin.setRawMode(false); }
    console.log(`Stopped. ${sentPkts} packets sent${o.loss ? `, ${dropped} dropped` : ''}.`);
    sock.close();
    process.exit(0);
  };

  const timer = setInterval(step, TICK_MS);
  const ui = tty ? setInterval(draw, 250) : null;
  process.on('SIGINT', quit);

  if (tty) {
    console.log(`WaveShare simulator, ${decks.length} deck(s). Keys: --help`);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (str, key = {}) => {
      const d = decks[sel], sr = d.track.sr;
      if (key.ctrl && key.name === 'c' || key.name === 'q') return quit();
      if (/^[1-4]$/.test(str) && +str <= decks.length) sel = +str - 1;
      else if (key.name === 'space') { d.playing = !d.playing; event = `Deck ${d.num}: ${d.playing ? 'play' : 'pause'}`; }
      else if (key.name === 'left' || key.name === 'right') {
        d.pos = Math.max(0, Math.min(d.track.len * sr - 1, d.pos + (key.name === 'left' ? -10 : 10) * sr));
        event = `Deck ${d.num}: seek to ${fmtTime(d.pos / sr)}`;
      } else if (key.name === 'up' || key.name === 'down') {
        d.speed = Math.max(0.5, Math.min(1.5, Math.round((d.speed + (key.name === 'up' ? 0.01 : -0.01)) * 100) / 100));
        event = `Deck ${d.num}: speed x${d.speed.toFixed(2)}`;
      } else if (str === 'n') { loadNext(d); event = `Deck ${d.num}: loaded ${d.track.title}`; }
      else if (str === 'l') {
        const beats = 8, inS = d.pos / sr, outS = Math.min(d.track.len, inS + beats * 60 / d.track.bpm);
        d.loop = d.loop ? null : { in: inS, out: outS, beats };
        event = `Deck ${d.num}: loop ${d.loop ? 'on' : 'off'}`;
      } else if ((str === '[' || str === ']') && d.loop) {
        const beats = str === '[' ? Math.max(0.125, d.loop.beats / 2) : Math.min(64, d.loop.beats * 2);
        d.loop = { in: d.loop.in, out: Math.min(d.track.len, d.loop.in + beats * 60 / d.track.bpm), beats };
        event = `Deck ${d.num}: loop ${beats} beats`;
      } else if (str === 'o') {
        d.on = !d.on;
        if (d.on) d.s.lastId = -1;               // OnStart: new sender thread starts from scratch
        event = `Deck ${d.num}: plugin ${d.on ? 'on' : 'off'}`;
      }
      draw();
    });
    draw();
  } else {
    console.log(`WaveShare simulator, ${decks.length} deck(s), sending to ${o.host}:${o.port}`);
    for (const d of decks) console.log(`  deck ${d.num}: ${d.queue.map(t => t.title).join(', ')}${d.playing ? '' : ' (paused)'}`);
  }
}

function fmtTime(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

if (require.main === module) main().catch(e => fail(e.stack || e.message));
else module.exports = { analyzer, decodeWav, decodeFfmpeg, estimateBpm, estimateFirstBeat, demoTrack, DEMOS };   // for tests
