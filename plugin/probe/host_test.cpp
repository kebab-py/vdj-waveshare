// Simulated VirtualDJ for the probe. Run: plugin/probe/test.sh (needs: node, port 7778 free)
#include "MasterProbe.cpp"
#include <cassert>
struct CB : IVdjCallbacks8 {
  HRESULT SendCommand(const char*) override { return 0; }
  HRESULT GetInfo(const char* c, double* r) override {
    *r = !strcmp(c, "deck 2 get_songlength") ? 177 : !strcmp(c, "deck 2 get_bpm") ? 124 : !strcmp(c, "deck 1 play") ? 1 : 0;
    return 0; }
  HRESULT GetStringInfo(const char*, void*, int) override { return 0; }
  HRESULT DeclareParameter(void*, int, int, const char*, const char*, float) override { return 0; }
  HRESULT GetSongBuffer(int, int, short**) override { return 1; }
};
int main() {
  CB cb; auto* p = new MasterProbe(); p->cb = &cb;
  p->OnStart();
  float buf[1024] = {0.5f};
  for (int i = 0; i < 300; i++) { assert(p->OnProcessSamples(buf, 512) == S_OK); usleep(10000); }  // ~100 calls/s
  assert(buf[0] == 0.5f);                              // audio untouched
  assert(p->len[1].load() == 177 && p->bpm[1].load() == 124 && p->play[0].load() && !p->play[1].load());
  p->OnStop(); p->Release();
  puts("OK");
}
