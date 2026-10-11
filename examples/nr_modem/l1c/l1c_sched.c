/* Core 0 - L1 control scheduler: grants, HARQ bookkeeping, TPC / TA, IPC to the PHY cores. */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "l1c_sched.h"

typedef struct { uint8_t rv; uint8_t ndi; uint8_t pending; uint8_t retx; } harq_entry_t;

static harq_entry_t s_dl_harq[NUM_HARQ];
static harq_entry_t s_ul_harq[NUM_HARQ];
static uint32_t     s_late_events;
static uint8_t      s_buf_idx;
static int8_t       s_tpc_acc_db;

static void sched_pick_ul(ul_grant_t *ul, uint8_t slot)
{
    harq_entry_t *h = &s_ul_harq[slot & (NUM_HARQ - 1u)];
    ul->valid     = 1u;
    ul->harq_id   = slot & (NUM_HARQ - 1u);
    ul->rv        = h->retx ? h->rv : 0u;
    ul->ndi       = h->ndi;
    ul->mcs       = 16u;
    ul->mod_order = 4u;
    ul->tbs       = 4096u;
    ul->prb_start = 10u;
    ul->prb_len   = 52u;
    ul->scr_seed  = (uint32_t)slot * 0x9E3779B9u;
}

static void sched_tpc_ta(ul_grant_t *ul)
{
    /* closed-loop power control from the latest measurement + accumulated TPC */
    if (g_meas_result.valid && g_meas_result.sinr_db < 10) {
        s_tpc_acc_db += 1;
    } else if (s_tpc_acc_db > 0) {
        s_tpc_acc_db -= 1;
    }
    ul->tpc_db = s_tpc_acc_db;
    g_nw_timing.ta_tc += g_track_state.ttl_acc >> 8;      /* TA follows the tracking loop */
}

static void sched_commit(const ul_grant_t *ul)
{
    IPC_SEND(CH_L1C_TO_UL, ul);
    IPC_SEND(CH_L1C_TO_MEAS, &g_nw_timing);
}

void l1c_schedule_slot(uint8_t slot)
{
    ul_grant_t *ul = &g_ul_grant[s_buf_idx];
    s_buf_idx ^= 1u;
    sched_pick_ul(ul, slot);
    sched_tpc_ta(ul);
    sched_commit(ul);
}

void l1c_harq_tick(void)
{
    if (g_dl_harq_ack.valid) {                       /* result written by core 1 PDSCH decoder */
        harq_entry_t *h = &s_dl_harq[g_dl_harq_ack.harq_id];
        if (g_dl_harq_ack.ack) {
            h->pending = 0u;
            h->ndi ^= 1u;
        } else {
            h->retx++;
            h->rv = (uint8_t)((h->rv + 2u) & 3u);
        }
        g_dl_harq_ack.valid = 0u;
    }
}

/* DCI decoded on core 1 arrives over IPC: register the DL grant and derive the UL HARQ state */
void l1c_on_dci(const dl_grant_t *dl, uint8_t slot)
{
    harq_entry_t *h = &s_dl_harq[dl->harq_id];
    h->pending = 1u;
    h->rv      = dl->rv;
    s_ul_harq[slot & (NUM_HARQ - 1u)].retx = (dl->ndi == 0u) ? 1u : 0u;
    IPC_SEND(CH_L1C_TO_DL, dl);
}

void sched_notify_late(uint32_t where)
{
    s_late_events += where;
}
