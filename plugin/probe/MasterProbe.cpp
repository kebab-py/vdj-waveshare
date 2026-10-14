// WaveShare Probe: throwaway test plugin, not for live sets.
// Question: does VirtualDJ call a DSP effect on the MASTER while every deck is paused, and do
// "deck N" script queries from that thread return the paused deck's length and BPM after a load?
// If yes, a master effect can drive the WaveShare deck instances like pre-load does.
// Audio passes through untouched. Results go to server.log as "deck 1 plugin: PROBE ..." lines.
#include <atomic>
#include <thread>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <chrono>
#include <algorithm>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include "vdjDsp8.h"

class MasterProbe : public IVdjPluginDsp8 {
public:
    HRESULT VDJ_API OnGetPluginInfo(TVdjPluginInfo8* info) override {
        info->PluginName = "WaveShare Probe";
        info->Author = "Kebab";
        info->Description = "Test: is the master effect called while all decks are paused";
        info->Version = "0.1";
        info->Flags = 0x00;
        info->Bitmap = NULL;
        return S_OK;
    }
    ULONG VDJ_API Release() override { stopSender(); delete this; return 0; }
    HRESULT VDJ_API OnStart() override { startSender(); return S_OK; }
    HRESULT VDJ_API OnStop() override { stopSender(); return S_OK; }

    // Audio thread: count calls, query decks at most 4x per second. No allocation, no locks, no I/O.
    HRESULT VDJ_API OnProcessSamples(float*, int) override {
        calls.fetch_add(1, std::memory_order_relaxed);
        auto now = std::chrono::steady_clock::now();
        if (now - queriedAt < std::chrono::milliseconds(250)) return S_OK;
        queriedAt = now;
        double v;
        GetInfo("get_deck", &(v = 0));
        whoAmI.store((int)v);
        for (int d = 0; d < 4; d++) {
            char c[64];
            auto q = [&](const char* s) { snprintf(c, sizeof c, "deck %d %s", d + 1, s); v = 0; GetInfo(c, &v); return v; };
            len[d].store((float)q("get_songlength"));
            bpm[d].store((float)q("get_bpm"));
            play[d].store(q("play") > 0);
        }
        return S_OK;
    }

    std::atomic<int> calls{0}, whoAmI{0};
    std::atomic<float> len[4], bpm[4];
    std::atomic<bool> play[4];

private:
    std::chrono::steady_clock::time_point queriedAt{};
    std::atomic<bool> running{false};
    std::thread sender;

    void startSender() {
        if (running.exchange(true)) return;
        sender = std::thread(&MasterProbe::sendLoop, this);
    }
    void stopSender() {
        running.store(false);
        if (sender.joinable()) sender.join();
    }

    // Own thread: reads probe memory only, never calls VirtualDJ. Logs once per second while anything
    // changes, and every 10 s anyway, so a silent log means "not called at all".
    void sendLoop() {
        int s = socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET; a.sin_port = htons(7778); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        char last[200] = "";
        int lastCalls = calls.load(), tick = 0;
        while (running.load()) {
            for (int i = 0; i < 10 && running.load(); i++) usleep(100000);
            int c = calls.load(), rate = c - lastCalls;
            lastCalls = c;
            char body[200];
            int n = snprintf(body, sizeof body, "deck=%d calls/s=%s", whoAmI.load(), rate == 0 ? "0" : rate < 50 ? "<50" : "50+");
            for (int d = 0; d < 4; d++)
                n += snprintf(body + n, sizeof body - n, " | d%d %s len=%.0f bpm=%.1f", d + 1,
                              play[d].load() ? "PLAY" : "stop", len[d].load(), bpm[d].load());
            if (!strcmp(body, last) && ++tick % 10) continue;
            snprintf(last, sizeof last, "%s", body);
            uint8_t p[12 + 220];
            uint32_t id = 0;
            memcpy(p, "VDJW", 4); p[4] = 1; p[5] = 4; p[6] = 1; p[7] = 0; memcpy(p + 8, &id, 4);
            int m = snprintf((char*)p + 12, 220, "PROBE %s", body);
            sendto(s, p, 12 + std::min(m, 219), 0, (sockaddr*)&a, sizeof a);
        }
        close(s);
    }
};

HRESULT VDJ_API DllGetClassObject(const GUID& rclsid, const GUID& riid, void** ppObject) {
    if (memcmp(&rclsid, &CLSID_VdjPlugin8, sizeof(GUID)) != 0) return CLASS_E_CLASSNOTAVAILABLE;
    if (memcmp(&riid, &IID_IVdjPluginDsp8, sizeof(GUID)) != 0) return CLASS_E_CLASSNOTAVAILABLE;
    *ppObject = new MasterProbe();
    return NO_ERROR;
}
