/* Core 1 - PDSCH decode pipeline, run from DL_PDSCH_ISR after the last symbol of the slot.
 * The stages are dispatched through a function-pointer table (the profiler resolves the indirect
 * call through the table and shows the stages as callees reached "via table").
 *
 *   EQ -> DEMAP (LLR) -> DESCR -> RDM + HARQ_BUF combine -> LDPC_DEC -> CRC -> deliver TB (DMA, MBOX)
 */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "../l1c/l1c_sched.h"
#include "dl_drv.h"
#include "dl_phy.h"

typedef struct {
    const dl_grant_t *grant;
    uint8_t          *soft;
    uint32_t          crc_ok;
    uint8_t           tb_idx;
} pdsch_ctx_t;

typedef struct {
    const char *name;
    void (*run)(pdsch_ctx_t *ctx);
} pdsch_stage_t;

static uint32_t s_crc_fail;
static uint32_t s_tb_count;
static uint8_t  s_out_idx;

static uint8_t *dl_harq_buffer(uint8_t harq_id, uint16_t tbs)
{
    if (g_harq_soft[harq_id] == 0) {
        g_harq_soft[harq_id] = (uint8_t *)pool_alloc((uint32_t)tbs * 8u);   /* heap use in ISR context */
    }
    return g_harq_soft[harq_id];
}

static void stage_eq(pdsch_ctx_t *ctx)
{
    dl_eq_prepare(ctx->grant);
}

static void stage_demap(pdsch_ctx_t *ctx)
{
    drv_demap_start(ctx->grant->mod_order, (uint8_t)(g_chest_result.noise >> 12));
}

static void stage_descramble(pdsch_ctx_t *ctx)
{
    drv_descr_start(ctx->grant->scr_seed);
}

static void stage_rate_dematch(pdsch_ctx_t *ctx)
{
    ctx->soft = dl_harq_buffer(ctx->grant->harq_id, ctx->grant->tbs);
    drv_rdm_start(ctx->grant->rv, ctx->grant->tbs);
    drv_harq_combine(ctx->grant->harq_id, ctx->soft);
}

static void stage_ldpc_decode(pdsch_ctx_t *ctx)
{
    drv_ldpc_start(1u, ctx->grant->tbs);
    hal_ldpc_wait();
    while (drv_ldpc_poll() == 0u) {
    }
}

static void stage_crc(pdsch_ctx_t *ctx)
{
    ctx->crc_ok = drv_crc_check(ctx->grant->tbs);
    if (ctx->crc_ok == 0u) {
        s_crc_fail++;
    }
    g_dl_harq_ack.harq_id = ctx->grant->harq_id;      /* consumed by core 2 (PUCCH) and core 0 */
    g_dl_harq_ack.ack     = (uint8_t)ctx->crc_ok;
    g_dl_harq_ack.valid   = 1u;
}

static void stage_deliver(pdsch_ctx_t *ctx)
{
    tb_desc_t *tb = &g_dl_tb_out[s_out_idx];
    s_out_idx ^= 1u;
    if (ctx->crc_ok) {
        tb->data    = ctx->soft;
        tb->len     = ctx->grant->tbs;
        tb->harq_id = ctx->grant->harq_id;
        tb->valid   = 1u;
        drv_dma_start((uint32_t)ctx->soft, 0x60000000u, ctx->grant->tbs);
        mac_if_indicate(MBOX_IND_DL_TB, (uint32_t)tb->len);   /* L1C module code executed on this core */
        s_tb_count++;
    }
    IPC_SEND(CH_DL_TO_UL, &g_dl_harq_ack);
}

static const pdsch_stage_t k_pdsch_stages[] = {
    { "eq",            stage_eq },
    { "demap",         stage_demap },
    { "descramble",    stage_descramble },
    { "rate-dematch",  stage_rate_dematch },
    { "ldpc",          stage_ldpc_decode },
    { "crc",           stage_crc },
    { "deliver",       stage_deliver },
};

void dl_pdsch_run(void)
{
    pdsch_ctx_t ctx;
    ctx.grant  = &g_dl_grant[g_nw_timing.slot & 1u];
    ctx.soft   = 0;
    ctx.crc_ok = 0u;
    ctx.tb_idx = 0u;
    if (!ctx.grant->valid) {
        return;
    }
    for (uint32_t i = 0u; i < sizeof(k_pdsch_stages) / sizeof(k_pdsch_stages[0]); i++) {
        k_pdsch_stages[i].run(&ctx);
    }
}
