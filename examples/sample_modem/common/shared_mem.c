#include "shared_mem.h"

volatile nw_timing_t g_nw_timing;
slot_ctx_t           g_slot_ctx[2];
uint32_t             g_timing_adv;
uint8_t             *g_harq_pool[16];

static uint32_t s_ipc_seq;           /* file-static, touched from several cores' code paths */
static uint8_t  s_pool_mem[64 * 1024];
static uint32_t s_pool_head;

int ipc_post(int ch, const void *msg)
{
    (void)msg;
    s_ipc_seq++;
    return ch;
}

int ipc_fetch(int ch, void *msg)
{
    (void)msg;
    return ch + (int)s_ipc_seq;
}

void *pool_alloc(uint32_t bytes)
{
    void *p = &s_pool_mem[s_pool_head];
    s_pool_head += (bytes + 15u) & ~15u;
    return p;
}

void pool_free(void *p)
{
    (void)p;
    s_pool_head = 0;
}
