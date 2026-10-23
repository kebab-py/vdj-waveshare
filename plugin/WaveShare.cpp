// WaveShare: 3-band waveform of a deck from the decoded audio, sent over UDP to 127.0.0.1:7778.
// Leaves the sound untouched. Packet format: docs/protocol.md.
#include <atomic>
#include <thread>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <algorithm>
#include <chrono>
#include <mutex>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include "vdjDsp8.h"

#ifndef UDP_PORT
#define UDP_PORT 7778                         // server.js udpPort; host_test overrides it
#endif

static const int BPS = 100;                  // columns per second
static const int MAXBINS = 30 * 60 * BPS;    // 30 min
static const int CHUNK = 8192;               // samples per VirtualDJ call
static const int PKT_BINS = 400;             // columns per packet
static const float GAIN[3] = {1.f, 1.5f, 2.5f};
static const float SCALE = 2.f;              // ponytail: column height calibration, set by eye, adjust after tests

// Pre-load: a playing deck also scans tracks on paused decks (VirtualDJ calls the plugin only while its deck plays).
class WaveShare;

// Beat grid: sample position of beat 0 (the song's first beat) from VirtualDJ's SongPosBeats
// (beats since the first beat) and SongBpm (samples per beat). Can be negative or past the start.
static int32_t beatAnchor(int songPos, double posBeats, int samplesPerBeat) {
    return (int32_t)(songPos - std::llround(posBeats * samplesPerBeat));
}

static const bool PRELOAD = true;             // false = pre-load off completely
// Test 13 Oct: VirtualDJ queries without "deck N" from another deck's audio thread returned the calling deck's data.
// So every query goes through q()/qs() with an explicit "deck N", and the audio is checked before pre-load (preloadCheck).
static std::atomic<int> g_preloadOk{0};       // 0 unchecked, 1 works, -1 VirtualDJ returns the calling deck's audio
static std::atomic<WaveShare*> g_decks[8];
static std::atomic<int> g_inTick{0};          // how many audio threads are touching other decks' instances right now

// Master clock: VirtualDJ calls effects on the master output even while every deck is paused (probe, 14 Oct 2026),
// but never calls a paused deck's Buffer DSP. WaveShareClock (plugin/WaveShareClock.cpp, its own bundle on the
// master) calls WaveShareClockTick() from the master audio thread, which drives idle decks the way pre-load does.
static const bool MASTER_CLOCK = true;        // false = ignore WaveShareClock
extern "C" __attribute__((visibility("default"))) void WaveShareClockTick();
static long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

class WaveShare : public IVdjPluginBufferDsp8 {
public:
    HRESULT VDJ_API OnLoad() override {
        bins = new uint8_t[MAXBINS * 3]();   // the only allocation, never on the audio thread
        return S_OK;
    }
    HRESULT VDJ_API OnGetPluginInfo(TVdjPluginInfo8* info) override {
        info->PluginName = "WaveShare";
        info->Author = "Kebab";
        info->Description = "Posiela waveform decku osvetlovacovi";
        info->Version = "1.0";
        info->Flags = 0x00;
        info->Bitmap = NULL;
        return S_OK;
    }
    ULONG VDJ_API Release() override { unregister(); stopSender(); delete[] bins; delete this; return 0; }
    HRESULT VDJ_API OnStart() override {
        double d = 0;
        deck = GetInfo("get_deck", &d) == S_OK ? (int)d : 1;
        startSender();
        for (auto& g : g_decks) { WaveShare* e = nullptr; if (g.compare_exchange_strong(e, this)) break; }
        return S_OK;
    }
    HRESULT VDJ_API OnStop() override { unregister(); stopSender(); return S_OK; }

    short* VDJ_API OnGetSongBuffer(int songPos, int nb) override {
        playPos.store(songPos, std::memory_order_relaxed);
        ownAt.store(nowMs(), std::memory_order_relaxed);
        if (SongBpm > 0) {                                                  // VDJ fills these before each call
            gridFirst.store(beatAnchor(songPos, SongPosBeats, SongBpm), std::memory_order_relaxed);
            gridBeat.store(SongBpm, std::memory_order_relaxed);
        }
        if (!busy.test_and_set()) {                                          // analysis BEFORE output
            checkTrack(songPos);
            if (total.load() > 0 && scanned.load() < total.load()) scanChunk();
            gatherMeta();
            busy.clear();
        }
        if (PRELOAD) tickOthers();
        short* out = nullptr;                                                // VirtualDJ may share the buffer
        if (GetSongBuffer(songPos, nb, &out) != S_OK) return nullptr;
        return out;
    }

private:
    friend void WaveShareClockTick();
    std::atomic<long long> ownAt{0};          // last call from this deck's own audio thread
    uint8_t* bins = nullptr;
    int deck = 1;

    // VirtualDJ query always for this deck, even when another deck's audio thread calls it
    double q(const char* c) {
        char cmd[96]; snprintf(cmd, sizeof cmd, "deck %d %s", deck, c);
        double v = 0;
        return GetInfo(cmd, &v) == S_OK ? v : 0.0;
    }
    void qs(const char* c, char* out, int n) {
        char cmd[96]; snprintf(cmd, sizeof cmd, "deck %d %s", deck, c);
        out[0] = 0;
        if (GetStringInfo(cmd, out, n) != S_OK) out[0] = 0;
    }

    // shared with the sender thread
    std::atomic<int> playPos{0}, sampleRate{44100}, total{0}, start{0}, scanned{0};
    std::atomic<uint32_t> trackId{0};
    // ponytail: grid only from this deck's own audio calls; a paused deck gets lines once it plays
    std::atomic<int32_t> gridFirst{0};
    std::atomic<int> gridBeat{0};                 // samples per beat, 0 = no grid
    std::atomic<bool> running{false};
    std::atomic_flag busy = ATOMIC_FLAG_INIT;   // only one thread at a time owns the scan state

    // Deck metadata for the server (instead of Network Control). The audio thread collects it, the sender thread sends it.
    struct Meta {
        uint8_t flags = 0;                       // bit 0 play, 1 audible, 2 loop, 3 pre-load OK, 4 pre-load off
        float bpm = 0, len = 0, loopIn = 0, loopOut = 0, loopBeats = 0;
        char title[200] = "", artist[200] = "", key[16] = "";
    };
    Meta meta;
    std::mutex metaMx;

    // Diagnostics for server.log: the audio thread writes a line (if the slot is free), the sender sends it as a type 4 packet.
    char logLine[200] = "";
    std::atomic<bool> logFull{false};
    char lastLog[200] = "";
    void dlog(const char* msg) {
        if (!strcmp(msg, lastLog) || logFull.load()) return;    // the same line only once
        snprintf(lastLog, sizeof lastLog, "%s", msg);
        snprintf(logLine, sizeof logLine, "%s", msg);
        logFull.store(true);
    }
    std::chrono::steady_clock::time_point metaAt{};
    std::thread sender;

    // audio thread only
    uint32_t trackHash = 0;
    int perBin = 441, scanBin = 0, scanPos = 0, inBin = 0;
    float a1 = 0, a2 = 0, l1 = 0, l2 = 0, acc[3] = {0, 0, 0};

    void checkTrack(int songPos) {
        double len = q("get_songlength");
        char t[256];
        qs("get_title", t, sizeof t);
        uint32_t h = 2166136261u;                                   // FNV-1a of title and length
        for (char* c = t; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
        h ^= (uint32_t)(len * 1000) ^ (uint32_t)SampleRate;
        if (h == trackHash) return;
        trackHash = h;

        scanned.store(0);                                           // sender stops reading the old data
        int sr = SampleRate > 0 ? SampleRate : 44100;
        perBin = sr / BPS;
        int tot = std::min(MAXBINS, (int)(len * BPS));              // floor: never read past the end of the track
        int st = tot > 0 ? std::clamp(songPos / perBin, 0, tot - 1) : 0;
        if (tot > 0) memset(bins, 0, tot * 3);
        a1 = 1 - std::exp(-2 * (float)M_PI * 200 / sr);
        a2 = 1 - std::exp(-2 * (float)M_PI * 2500 / sr);
        resetFilter();
        scanBin = st; scanPos = st * perBin;                        // first from the playhead to the end
        sampleRate.store(sr); start.store(st); total.store(tot);
        gridBeat.store(0);                                          // old grid does not fit the new track
        trackId.fetch_add(1);
    }

    void unregister() {
        for (auto& g : g_decks) { WaveShare* e = this; g.compare_exchange_strong(e, nullptr); }
        while (g_inTick.load()) usleep(1000);   // nobody touches this instance anymore
    }

    // Called by a playing deck's audio thread. Paused deck: gets track and position from VirtualDJ and scans.
    void tickOthers() {
        g_inTick++;
        for (auto& g : g_decks) {
            WaveShare* o = g.load();
            if (!o || o == this || o->busy.test_and_set()) continue;
            if (g_preloadOk.load() == 0) preloadCheck(o);
            o->tickRemote(g_preloadOk.load() == 1);            // metadata always, audio only once checked
            o->busy.clear();
        }
        g_inTick--;
    }
    // Does VirtualDJ return the other deck's audio through its instance, or the calling deck's? Compares 1024 frames
    // at the same position. Match = VirtualDJ returns audio by thread, pre-load switches off. (The same track on both
    // decks switches pre-load off too, ponytail: rare, a VirtualDJ restart fixes it.)
    int checkFails = 0;
    void preloadCheck(WaveShare* o) {
        double lenA = q("get_songlength"), lenB = o->q("get_songlength");
        if (lenA < 20 || lenB < 20 || SampleRate <= 0) { dlog("preload test: caka na skladby dlhsie ako 20 s na oboch deckoch"); return; }
        int pos = (int)(std::min(lenA, lenB) / 2 * SampleRate);
        short a[2048];                                                   // 4 kB on the audio thread's stack
        short* p = nullptr;
        if (GetSongBuffer(pos, 1024, &p) != S_OK || !p) { dlog("preload test: vlastne audio nedostupne"); return; }
        memcpy(a, p, sizeof a);
        short* r = nullptr;
        if (o->GetSongBuffer(pos, 1024, &r) != S_OK || !r) {
            if (++checkFails == 50) { g_preloadOk.store(-1); dlog("preload VYPNUTY: VDJ nedava audio ineho decku (GetSongBuffer zlyhava)"); }
            else dlog("preload test: audio ineho decku zatial nedostupne");
            return;
        }
        bool silent = true;
        for (int i = 0; i < 2048; i++) if (a[i]) { silent = false; break; }
        if (silent) { dlog("preload test: ticho na testovacej pozicii, skusim neskor"); return; }
        int res = memcmp(a, r, sizeof a) == 0 ? -1 : 1;
        g_preloadOk.store(res);
        dlog(res > 0 ? "preload OK" : "preload VYPNUTY: VDJ vracia audio volajuceho decku");
    }

    void tickRemote(bool scan) {
        double len = q("get_songlength"), frac = q("get_position");
        if (frac > 1) frac /= 100;                                  // ponytail: accepts both 0-1 and 0-100
        // ponytail: SampleRate is from the last played track; if it is wrong, the track gets rescanned when it plays
        int pos = (int)(frac * len * (SampleRate > 0 ? SampleRate : 44100));
        if (std::abs(pos - playPos.load()) > SampleRate / 10) playPos.store(pos);  // the exact position from playback wins
        checkTrack(playPos.load());
        if (scan && total.load() > 0 && scanned.load() < total.load()) scanChunk();
        gatherMeta();
    }

    // at most 4 times per second; the audio thread never waits for a lock
    void gatherMeta() {
        auto now = std::chrono::steady_clock::now();
        if (now - metaAt < std::chrono::milliseconds(250)) return;
        Meta m;
        auto get = [&](const char* c) { return q(c); };
        if (get("play") > 0) m.flags |= 1;
        if (get("is_audible") > 0) m.flags |= 2;
        if (get("loop") > 0) m.flags |= 4;
        int pl = g_preloadOk.load();                                    // pre-load state for the server and log
        if (pl > 0) m.flags |= 8; else if (pl < 0) m.flags |= 16;
        m.bpm = (float)get("get_bpm");
        m.len = (float)get("get_songlength");
        if (m.flags & 4) {
            m.loopIn = (float)(get("get_loop_in_time") / 1000);  // ms → s
            m.loopOut = (float)(get("get_loop_out_time") / 1000);
            m.loopBeats = (float)get("get_active_loop");
        }
        qs("get_title", m.title, sizeof m.title);
        qs("get_artist", m.artist, sizeof m.artist);
        qs("get_key", m.key, sizeof m.key);
        if (metaMx.try_lock()) { meta = m; metaAt = now; metaMx.unlock(); }
    }

    void resetFilter() { l1 = l2 = 0; acc[0] = acc[1] = acc[2] = 0; inBin = 0; }

    void scanChunk() {
        int tot = total.load();
        int frames = std::min(CHUNK, tot * perBin - scanPos);
        short* b = nullptr;
        if (frames <= 0 || GetSongBuffer(scanPos, frames, &b) != S_OK || !b) return;  // retried on the next call
        for (int i = 0; i < frames; i++) {
            float x = (b[2 * i] + b[2 * i + 1]) * (0.5f / 32768.f);
            l1 += a1 * (x - l1); l2 += a2 * (x - l2);
            float lo = l1, mi = l2 - l1, hi = x - l2;
            acc[0] += lo * lo; acc[1] += mi * mi; acc[2] += hi * hi;
            if (++inBin < perBin) continue;
            for (int k = 0; k < 3; k++) {
                float v = std::sqrt(acc[k] / perBin) * GAIN[k] * SCALE * 255.f;
                bins[scanBin * 3 + k] = (uint8_t)std::min(255.f, v);
            }
            acc[0] = acc[1] = acc[2] = 0; inBin = 0;
            scanBin++;
            scanned.fetch_add(1, std::memory_order_release);
            if (scanned.load() == tot) return;                      // done
            if (scanBin == tot) {                                   // end of track: continue from the start
                scanBin = 0; scanPos = 0; resetFilter();            // a short artifact at the start is OK
                return;
            }
        }
        scanPos += frames;
    }

    void startSender() {
        if (running.exchange(true)) return;
        sender = std::thread(&WaveShare::sendLoop, this);
    }
    void stopSender() {
        running.store(false);
        if (sender.joinable()) sender.join();
    }

    void header(uint8_t* p, uint8_t type, uint32_t id) {
        memcpy(p, "VDJW", 4); p[4] = 1; p[5] = type; p[6] = (uint8_t)deck; p[7] = 0;
        memcpy(p + 8, &id, 4);                                      // macOS is little-endian
    }

    // Own thread: reads plugin memory only, never calls VirtualDJ.
    void sendLoop() {
        int s = socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET; a.sin_port = htons(UDP_PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        static_assert(PKT_BINS * 3 + 18 < 1400, "paket musí byť menší než MTU");
        uint8_t p[18 + PKT_BINS * 3];
        uint32_t lastId = ~0u;
        int sent = 0, ring = 0;                                     // in scan order from `start`
        bool dumped = false;
        int tick = 0;
        uint8_t mp[12 + 28 + 3 * 201 + 8];
        while (running.load()) {
            uint32_t id = trackId.load(std::memory_order_acquire);
            int tot = total.load(), st = start.load(), sc = scanned.load(std::memory_order_acquire);
            if (id != lastId) { lastId = id; sent = ring = 0; dumped = false; }

            uint32_t v[4] = {(uint32_t)playPos.load(), (uint32_t)sampleRate.load(), (uint32_t)tot, (uint32_t)sc};
            header(p, 1, id); memcpy(p + 12, v, 16);
            sendto(s, p, 28, 0, (sockaddr*)&a, sizeof a);

            if (sc > 0 && tot > 0) {
                bool fresh = sent < sc;                             // new columns go before the ring
                int k = fresh ? sent : ring;
                int b0 = (st + k) % tot;
                int n = std::min({PKT_BINS, sc - k, tot - b0});
                uint32_t b0u = b0; uint16_t nu = n;
                header(p, 2, id); memcpy(p + 12, &b0u, 4); memcpy(p + 16, &nu, 2);
                memcpy(p + 18, bins + b0 * 3, n * 3);
                if (trackId.load() == id) {                         // the track did not change meanwhile
                    sendto(s, p, 18 + n * 3, 0, (sockaddr*)&a, sizeof a);
                    if (fresh) sent += n; else if ((ring += n) >= sc) ring = 0;
                }
            }

            if (++tick % 5 == 0) {                                  // metadata 4 times per second
                Meta m; std::chrono::steady_clock::time_point at;
                { std::lock_guard<std::mutex> g(metaMx); m = meta; at = metaAt; }
                if (at.time_since_epoch().count()) {
                    uint32_t age = (uint32_t)std::min<long long>(UINT32_MAX,
                        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - at).count());
                    float f[5] = {m.bpm, m.len, m.loopIn, m.loopOut, m.loopBeats};
                    header(mp, 3, id);
                    mp[12] = m.flags; mp[13] = mp[14] = mp[15] = 0;
                    memcpy(mp + 16, &age, 4); memcpy(mp + 20, f, 20);
                    size_t o = 40;
                    for (const char* str : {m.title, m.artist, m.key}) {
                        size_t n = std::min<size_t>(strnlen(str, 200), 200);
                        mp[o++] = (uint8_t)n; memcpy(mp + o, str, n); o += n;
                    }
                    int32_t g0 = gridFirst.load(); uint32_t gb = (uint32_t)gridBeat.load();
                    memcpy(mp + o, &g0, 4); memcpy(mp + o + 4, &gb, 4); o += 8;       // beat grid, protocol docs
                    sendto(s, mp, o, 0, (sockaddr*)&a, sizeof a);
                }
            }

            if (logFull.load()) {                                    // diagnostics for server.log
                size_t n = strnlen(logLine, sizeof logLine);
                header(mp, 4, id); memcpy(mp + 12, logLine, n);
                sendto(s, mp, 12 + n, 0, (sockaddr*)&a, sizeof a);
                logFull.store(false);
            }

            if (!dumped && tot > 0 && sc == tot) {                  // dump for checks (host_test reads it)
                char fn[64];
                snprintf(fn, sizeof fn, "/tmp/waveshare_deck%d.bin", deck);
                if (FILE* f = fopen(fn, "wb")) { fwrite(bins, 3, tot, f); fclose(f); }
                dumped = true;
            }
            usleep(50000);                                          // 20 times per second
        }
        close(s);
    }
};

// Master audio thread, about 100x per second. Only decks whose own audio thread is idle (paused deck)
// get ticked, so a playing deck keeps its exact position. busy keeps one thread per deck at a time.
// ponytail: scans also while the pre-load audio check is still pending (nothing played yet this session),
// since audio from a foreign VirtualDJ thread was confirmed correct on 13 Oct; a failed check (-1) stops it.
void WaveShareClockTick() {
    if (!MASTER_CLOCK) return;
    static std::atomic<bool> seen{false};
    g_inTick++;
    long long now = nowMs();
    for (auto& g : g_decks) {
        WaveShare* o = g.load();
        if (!o || now - o->ownAt.load(std::memory_order_relaxed) < 200 || o->busy.test_and_set()) continue;
        if (!seen.exchange(true)) o->dlog("master clock: bezi");
        o->tickRemote(g_preloadOk.load() != -1);
        o->busy.clear();
    }
    g_inTick--;
}

HRESULT VDJ_API DllGetClassObject(const GUID& rclsid, const GUID& riid, void** ppObject) {
    if (memcmp(&rclsid, &CLSID_VdjPlugin8, sizeof(GUID)) != 0) return CLASS_E_CLASSNOTAVAILABLE;
    if (memcmp(&riid, &IID_IVdjPluginBuffer8, sizeof(GUID)) != 0) return CLASS_E_CLASSNOTAVAILABLE;
    *ppObject = new WaveShare();
    return NO_ERROR;
}
