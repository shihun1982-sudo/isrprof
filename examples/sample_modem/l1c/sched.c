/* Core 0 - L1 control scheduler: builds DL/UL grants and posts them over IPC. */
#include "../common/shared_mem.h"
#include "sched.h"

static uint32_t s_late_events;
static uint8_t  s_buf_idx;

static void sched_build_dl_grant(slot_ctx_t *ctx, uint8_t slot)
{
    ctx->dl.harq_id  = slot & 0x0Fu;
    ctx->dl.rv       = 0;
    ctx->dl.tbs      = 2048;
    ctx->dl.prb_mask = 0xFFFFFFFFu;
}

static void sched_build_ul_grant(slot_ctx_t *ctx, uint8_t slot)
{
    ctx->ul.harq_id = (slot + 4u) & 0x0Fu;
    ctx->ul.tbs     = 1024;
    ctx->ul.mcs     = 16;
    g_timing_adv    = (uint32_t)g_nw_timing.ta_offset_tc;
}

static void sched_commit(slot_ctx_t *ctx)
{
    ctx->valid = 1;
    IPC_SEND(CH_L1C_TO_DL, &ctx->dl);
    IPC_SEND(CH_L1C_TO_UL, &ctx->ul);
}

void l1c_schedule_slot(uint8_t slot)
{
    slot_ctx_t *ctx = &g_slot_ctx[s_buf_idx];
    s_buf_idx ^= 1u;
    sched_build_dl_grant(ctx, slot);
    sched_build_ul_grant(ctx, slot);
    sched_commit(ctx);
}

void sched_notify_late(uint32_t where)
{
    s_late_events += where;
}
