// Simulated VirtualDJ for the plugin logic. Run: plugin/test.sh
#include <cmath>
#include "WaveShare.cpp"
#include <cassert>
#include <vector>
// Deck 1 plays a 60 s track (first half 60 Hz, second half 6 kHz). Deck 2 has a 30 s track (6 kHz) loaded and is paused.
const int SR = 44100;
bool contaminate = false;                              // simulation: VirtualDJ returns the calling deck's audio
struct CB;
CB* cb1p = nullptr;
struct CB : IVdjCallbacks8 {
  int deck, len; std::vector<short> song;
  CB(int d, int l, bool split) : deck(d), len(l), song(2 * SR * l) {
    for (int i = 0; i < SR * l; i++) {
      float f = split && i < SR * l / 2 ? 60 : 6000;
      song[2*i] = song[2*i+1] = (short)(16000 * sin(2 * M_PI * f * i / SR));
    }
  }
  HRESULT SendCommand(const char*) override { return 0; }
  HRESULT GetInfo(const char* c, double* r) override {
    if (!strncmp(c, "deck ", 5)) { assert(atoi(c + 5) == deck); c = strchr(c + 5, ' ') + 1; }
    *r = !strcmp(c, "get_deck") ? deck : !strcmp(c, "get_position") ? 0.1 : !strcmp(c, "play") ? deck == 1
       : !strcmp(c, "is_audible") ? 1 : !strcmp(c, "loop") ? 1 : !strcmp(c, "get_loop_in_time") ? 30000
       : !strcmp(c, "get_loop_out_time") ? 31875 : !strcmp(c, "get_active_loop") ? 4 : !strcmp(c, "get_bpm") ? 128 : len;
    return 0; }
  HRESULT GetStringInfo(const char* c, void* r, int n) override {
    if (!strncmp(c, "deck ", 5)) assert(atoi(c + 5) == deck); snprintf((char*)r, n, "Test %d", deck); return 0; }
  HRESULT DeclareParameter(void*, int, int, const char*, const char*, float) override { return 0; }
  HRESULT GetSongBuffer(int pos, int nb, short** b) override {
    if (contaminate && this != cb1p) return cb1p->GetSongBuffer(pos, nb, b);
    if (pos < 0 || (pos + nb) * 2 > (int)song.size()) return 1;
    *b = &song[2 * pos]; return 0;
  }
};
std::vector<uint8_t> dump(int deck, int bins) {
  char fn[64]; snprintf(fn, sizeof fn, "/tmp/waveshare_deck%d.bin", deck);
  FILE* f = fopen(fn, "rb"); assert(f);
  std::vector<uint8_t> d(bins * 3); assert(fread(d.data(), 3, bins, f) == (size_t)bins); fclose(f);
  return d;
}
int main(int argc, char** argv) {
  bool clock = argc > 1 && !strcmp(argv[1], "clock");  // ./host_test clock = both decks paused, master clock only
  contaminate = argc > 1 && !clock;                    // ./host_test x = pre-load must switch itself off
  // beat grid: beat 0 at 1.0 s, 120 BPM (22050 samples per beat)
  assert(beatAnchor(44100 + 2 * 22050, 2.0, 22050) == 44100);   // 2 beats after beat 0
  assert(beatAnchor(11025, 0.5, 22050) == 0);                    // half a beat in
  assert(beatAnchor(0, 3.25, 22050) == -71663);                 // first beat after the track start, rounded
  remove("/tmp/waveshare_deck1.bin"); remove("/tmp/waveshare_deck2.bin");
  CB cb1(1, 60, true), cb2(2, 30, false);
  cb1p = &cb1;
  auto* p1 = new WaveShare(); p1->cb = &cb1; p1->SampleRate = SR;
  auto* p2 = new WaveShare(); p2->cb = &cb2; p2->SampleRate = SR;
  p1->OnLoad(); p1->OnStart(); p2->OnLoad(); p2->OnStart();
  if (clock) {                                         // VirtualDJ never calls the decks, only the master effect
    for (int i = 0; i < 600; i++) { WaveShareClockTick(); usleep(5000); }
    usleep(300000);
    auto d = dump(1, 6000), e = dump(2, 3000);
    printf("clock: deck1 bin 1000 low %d, deck2 bin 1500 high %d\n", d[3000], e[4502]);
    assert(d[3000] > 100 && d[3002] < 20 && d[15002] > 100);   // deck 1: bass, then highs
    assert(e[4502] > 100);                                      // deck 2: highs
    p1->OnStop(); p2->OnStop(); p1->Release(); p2->Release();
    puts("OK (master clock)");
    return 0;
  }
  int pos = 20 * SR;                                   // deck 1 starts in the middle: tests the wrap
  for (int i = 0; i < 600; i++) { assert(p1->OnGetSongBuffer(pos, 512)); pos += 512; usleep(5000); }
  usleep(300000);
  auto d = dump(1, 6000);
  printf("deck1 bin 1000 low/mid/high %d %d %d\n", d[3000], d[3001], d[3002]);
  printf("deck1 bin 5000 low/mid/high %d %d %d\n", d[15000], d[15001], d[15002]);
  assert(d[3000] > 100 && d[3002] < 20);               // 60 Hz: bass
  assert(d[15002] > 100 && d[15000] < 20);             // 6 kHz: highs
  for (int b = 5; b < 6000; b++) assert(d[b*3] + d[b*3+1] + d[b*3+2] > 0);  // no gap
  if (contaminate) {                                   // pre-load must switch off, deck 2 must not get scanned
    assert(g_preloadOk.load() == -1);
    assert(!fopen("/tmp/waveshare_deck2.bin", "rb"));
    p1->OnStop(); p2->OnStop(); p1->Release(); p2->Release();
    puts("OK (pre-load vypnutý)");
    return 0;
  }
  assert(g_preloadOk.load() == 1);
  auto e = dump(2, 3000);                              // deck 2 never played, still done (pre-load)
  printf("deck2 bin 1500 low/mid/high %d %d %d\n", e[4500], e[4501], e[4502]);
  assert(e[4502] > 100);
  p1->OnStop(); p2->OnStop(); p1->Release(); p2->Release();
  puts("OK");
}
