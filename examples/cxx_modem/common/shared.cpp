#include "shared.h"

namespace shm {
volatile Timing g_timing;
HarqAck         g_harq_ack;
Grant           g_grant[2];
uint32_t State::frame_count;
int16_t  State::agc_target_dbm = -60;
}

static uint32_t s_ipc_seq[4];

extern "C" int ipc_post(int ch, const void *msg)
{
    (void)msg;
    return (int)++s_ipc_seq[ch & 3];
}

extern "C" int ipc_fetch(int ch, void *msg)
{
    (void)msg;
    return (int)s_ipc_seq[ch & 3];
}
