// WaveShareClock: master effect that keeps WaveShare running while every deck is paused.
// VirtualDJ calls master effects all the time, but a deck's Buffer DSP only while the deck plays.
// This plugin finds the loaded WaveShare bundle and calls its WaveShareClockTick() from the master audio
// thread. Audio passes through untouched. Without WaveShare on a deck it does nothing.
#include <atomic>
#include <thread>
#include <cstring>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <unistd.h>
#include "vdjDsp8.h"

class WaveShareClock : public IVdjPluginDsp8 {
public:
    HRESULT VDJ_API OnGetPluginInfo(TVdjPluginInfo8* info) override {
        info->PluginName = "WaveShare Clock";
        info->Author = "Kebab";
        info->Description = "Put on the master: WaveShare loads tracks on paused decks";
        info->Version = "1.0";
        info->Flags = 0x00;
        info->Bitmap = NULL;
        return S_OK;
    }
    ULONG VDJ_API Release() override {
        stopFinder();
        if (handle) dlclose(handle);
        delete this;
        return 0;
    }
    HRESULT VDJ_API OnStart() override { startFinder(); return S_OK; }
    HRESULT VDJ_API OnStop() override { stopFinder(); return S_OK; }

    // Audio thread: one atomic load and a call into WaveShare.
    HRESULT VDJ_API OnProcessSamples(float*, int) override {
        if (auto t = tick.load(std::memory_order_acquire)) t();
        return S_OK;
    }

private:
    std::atomic<void (*)()> tick{nullptr};
    void* handle = nullptr;
    std::atomic<bool> running{false};
    std::thread finder;

    // Own thread, never calls VirtualDJ: looks for WaveShare among loaded images once per second until found.
    // dlopen(RTLD_NOLOAD) only returns an already loaded image and keeps it loaded until our dlclose.
    void findLoop() {
        while (running.load() && !tick.load()) {
            for (uint32_t i = 0; i < _dyld_image_count() && !handle; i++) {
                const char* n = _dyld_get_image_name(i);
                const char* want = "/WaveShare.bundle/Contents/MacOS/WaveShare";
                size_t ln = strlen(n), lw = strlen(want);
                if (ln >= lw && !strcmp(n + ln - lw, want)) handle = dlopen(n, RTLD_NOLOAD | RTLD_LAZY);
            }
            if (handle) {
                tick.store((void (*)())dlsym(handle, "WaveShareClockTick"), std::memory_order_release);
                if (tick.load()) break;
            }
            for (int i = 0; i < 10 && running.load(); i++) usleep(100000);
        }
    }
    void startFinder() {
        if (running.exchange(true)) return;
        finder = std::thread(&WaveShareClock::findLoop, this);
    }
    void stopFinder() {
        running.store(false);
        if (finder.joinable()) finder.join();
    }
};

HRESULT VDJ_API DllGetClassObject(const GUID& rclsid, const GUID& riid, void** ppObject) {
    if (memcmp(&rclsid, &CLSID_VdjPlugin8, sizeof(GUID)) != 0) return CLASS_E_CLASSNOTAVAILABLE;
    if (memcmp(&riid, &IID_IVdjPluginDsp8, sizeof(GUID)) != 0) return CLASS_E_CLASSNOTAVAILABLE;
    *ppObject = new WaveShareClock();
    return NO_ERROR;
}
