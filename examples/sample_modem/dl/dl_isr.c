/* Core 1 - DL PHY interrupt handlers.
 *  dl_symbol_isr : every symbol, DL timing lane (NW - propagation delay)
 *  dl_slot_isr   : once per slot, higher priority lane, PDCCH -> PDSCH pipeline
 */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "dl_drv.h"

typedef struct {
    uint32_t symbols;
    uint32_t crc_fail;
    uint32_t late_fft;
} dl_stats_t;

static dl_stats_t s_dl_stats;                 /* file-static */
static dl_grant_t s_cur_grant;
static uint8_t    s_sym_in_slot;

/* ---------------------------------------------------------------- symbol path */

static void dl_fft_kick(uint32_t size)
{
    drv_fft_configure(size);
    drv_fft_start();
    s_dl_stats.symbols++;
}

static void dl_chest_run(void)
{
    if (HW_RD(FFT, STATUS) & 0x1u) {
        drv_chest_start(s_cur_grant.prb_mask);
    } else {
        s_dl_stats.late_fft++;
    }
}

static void dl_track_symbol(void)
{
    s_sym_in_slot = (uint8_t)((s_sym_in_slot + 1u) % 14u);
    g_nw_timing.symbol = s_sym_in_slot;      /* writes the shared timing struct */
}

void dl_symbol_isr(void)
{
    dl_track_symbol();
    dl_fft_kick(4096u);
    dl_chest_run();
}

/* ---------------------------------------------------------------- slot path */

static uint32_t dl_pdcch_decode(void)
{
    static uint32_t dci_count;              /* function-static */
    IPC_RECV(CH_L1C_TO_DL, &s_cur_grant);
    dci_count++;
    return s_cur_grant.tbs;
}

static uint8_t *dl_harq_buffer(uint8_t harq_id, uint32_t tbs)
{
    if (g_harq_pool[harq_id] == 0) {
        g_harq_pool[harq_id] = (uint8_t *)pool_alloc(tbs * 8u);   /* heap use inside ISR */
    }
    return g_harq_pool[harq_id];
}

static void dl_ldpc_schedule(uint32_t tbs)
{
    uint8_t *soft = dl_harq_buffer(s_cur_grant.harq_id, tbs);
    drv_ldpc_start(1u, tbs, soft);
    hal_ldpc_wait();
    if (drv_ldpc_poll() == 0u) {
        s_dl_stats.crc_fail++;
    }
}

static void dl_harq_report(void)
{
    IPC_SEND(CH_DL_TO_L1C, &s_dl_stats);
}

void dl_slot_isr(void)
{
    uint32_t tbs = dl_pdcch_decode();
    dl_ldpc_schedule(tbs);
    dl_harq_report();
}
