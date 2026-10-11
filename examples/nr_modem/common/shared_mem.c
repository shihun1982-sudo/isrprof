#include "shared_mem.h"

volatile nw_timing_t g_nw_timing;
dl_grant_t           g_dl_grant[2];
ul_grant_t           g_ul_grant[2];
harq_ack_t           g_dl_harq_ack;
csi_report_t         g_csi_report;
meas_result_t        g_meas_result;
chest_result_t       g_chest_result;
track_state_t        g_track_state;
rf_state_t           g_rf_state;
tb_desc_t            g_ul_tb_queue[TB_QUEUE_LEN];
tb_desc_t            g_dl_tb_out[2];
uint8_t             *g_harq_soft[NUM_HARQ];

static uint32_t s_ipc_seq[8];
static uint8_t  s_pool_mem[256u * 1024u];
static uint32_t s_pool_head;

int ipc_post(int ch, const void *msg)
{
    (void)msg;
    s_ipc_seq[ch]++;
    return ch;
}

int ipc_fetch(int ch, void *msg)
{
    (void)msg;
    return (int)s_ipc_seq[ch];
}

void *pool_alloc(uint32_t bytes)
{
    void *p = &s_pool_mem[s_pool_head];
    s_pool_head += (bytes + 31u) & ~31u;
    return p;
}

void pool_free(void *p)
{
    (void)p;
    s_pool_head = 0u;
}
