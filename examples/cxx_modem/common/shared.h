// C++ modem sample - shared state between the DL and UL cores, a C++ singleton-style state area and IPC.
#pragma once
#include <stdint.h>

namespace shm {

struct Timing { uint16_t sfn; uint8_t slot; uint8_t symbol; int32_t ta_tc; };
struct HarqAck { uint8_t harq_id; uint8_t ack; uint8_t valid; };
struct Grant   { uint8_t valid; uint8_t mcs; uint16_t tbs; uint32_t seed; };

extern volatile Timing g_timing;      // DL core writes the symbol counter, UL core reads TA
extern HarqAck         g_harq_ack;    // DL -> UL
extern Grant           g_grant[2];    // scheduler -> DL / UL

// A platform state area with class-static members (tracked as `State::member` symbols)
class State {
public:
    static uint32_t frame_count;
    static int16_t  agc_target_dbm;
    static void     bump() { frame_count++; }
};

}  // namespace shm

#define IPC_SEND(ch, msg) ipc_post((ch), (const void *)(msg))
#define IPC_RECV(ch, msg) ipc_fetch((ch), (void *)(msg))
#define CH_DL_TO_UL 1

extern "C" int ipc_post(int ch, const void *msg);
extern "C" int ipc_fetch(int ch, void *msg);
