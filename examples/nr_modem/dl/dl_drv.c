/* Core 1 - DL PHY drivers for the RX chain:
 *   RFIC(AGC) -> DFE_RX -> FFT -> CHEST -> EQ -> DEMAP -> DESCR -> RDM/HARQ_BUF -> LDPC_DEC -> CRC -> DMA
 * plus POLAR for PDCCH.  Every function is a thin register sequence; the profiler attributes each
 * HW_* macro to (block, register, read|write) and checks it against the block's HW-line deadline.
 */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "../l1c/l1c_sched.h"
#include "dl_drv.h"

static uint32_t s_dma_retries;
static uint16_t s_fft_cp_cached;
static uint8_t  s_last_gain;

void drv_dfe_rx_config(uint8_t sym)
{
    HW_WR(DFE_RX, DCOC, 0x100u | sym);
    HW_WR(DFE_RX, IQCORR, 0x0804u);
    HW_WR(DFE_RX, START, 1u);
}

void drv_fft_kick(uint8_t sym, uint16_t cp_len)
{
    if (cp_len != s_fft_cp_cached) {
        HW_WR(FFT, CP_LEN, cp_len);
        s_fft_cp_cached = cp_len;
    }
    HW_RMW(FFT, CTRL, 0x7u, (uint32_t)(sym & 0x1u));
    HW_WR(FFT, START, 1u);
}

int16_t drv_rfic_read_rssi(void)
{
    return (int16_t)HW_RD(RFIC, RSSI);
}

void drv_rfic_set_rx_gain(uint8_t gain)
{
    if (gain != s_last_gain) {
        HW_WR(RFIC, RX_GAIN, gain);
        s_last_gain = gain;
    }
}

void drv_chest_start(uint16_t dmrs_cfg, uint32_t prb_mask)
{
    HW_WR(CHEST, DMRS_CFG, dmrs_cfg);
    HW_WR(CHEST, CTRL, prb_mask);
    HW_WR(CHEST, START, 1u);
}

void drv_chest_read(chest_result_t *out)
{
    out->noise     = HW_RD(CHEST, NOISE);
    out->to_est_tc = (int32_t)HW_RD(CHEST, TO_EST);
    out->fo_est_hz = (int32_t)HW_RD(CHEST, FO_EST);
    out->valid     = 1u;
}

void drv_eq_config(uint8_t mode, uint16_t prb_start, uint16_t prb_len)
{
    HW_WR(EQ, MODE, mode);
    HW_WR(EQ, CTRL, ((uint32_t)prb_start << 16) | prb_len);
    HW_WR(EQ, START, 1u);
}

void drv_polar_decode(uint8_t cand, uint8_t list_size, uint32_t *dci_out)
{
    HW_WR(POLAR, LIST_SIZE, list_size);
    HW_WR(POLAR, CTRL, cand);
    HW_WR(POLAR, START, 1u);
    HW_POLL(POLAR, STATUS, 0x1u);
    *dci_out = HW_RD(POLAR, OUT);
}

void drv_demap_start(uint8_t mod_order, uint8_t llr_scale)
{
    HW_WR(DEMAP, MOD_ORDER, mod_order);
    HW_WR(DEMAP, LLR_SCALE, llr_scale);
    HW_WR(DEMAP, START, 1u);
}

void drv_descr_start(uint32_t seed)
{
    HW_WR(DESCR, SEED, seed);
    HW_WR(DESCR, START, 1u);
}

void drv_rdm_start(uint8_t rv, uint16_t tbs)
{
    HW_WR(RDM, RV, rv);
    HW_WR(RDM, CTRL, tbs);
    HW_WR(RDM, START, 1u);
}

void drv_harq_combine(uint8_t harq_id, uint8_t *soft)
{
    HW_WR(HARQ_BUF, BASE_ADDR, (uint32_t)soft);
    HW_WR(HARQ_BUF, CTRL, harq_id);
    HW_WR(HARQ_BUF, COMBINE, 1u);
}

void drv_ldpc_start(uint8_t bg, uint16_t tbs)
{
    HW_WR(LDPC_DEC, BG, bg);
    HW_WR(LDPC_DEC, ITER_MAX, 20u);
    HW_WR(LDPC_DEC, CTRL, tbs);
    HW_WR(LDPC_DEC, START, 1u);
}

uint32_t drv_ldpc_poll(void)
{
    return HW_RD(LDPC_DEC, STATUS) & 0x1u;
}

/* Intentional structural smell: a HAL-level wait that calls *up* into the L1C scheduler. */
void hal_ldpc_wait(void)
{
    uint32_t iter = HW_RD(LDPC_DEC, ITER_CNT);
    if (iter > 18u) {
        sched_notify_late(iter);
    }
}

uint32_t drv_crc_check(uint16_t tbs)
{
    HW_WR(CRC, CTRL, tbs);
    HW_WR(CRC, START, 1u);
    return HW_RD(CRC, RESULT);
}

/* Intentional structural smell: a tangle (drv_dma_start <-> dl_dma_done_cb). */
void drv_dma_start(uint32_t src, uint32_t dst, uint32_t len)
{
    HW_WR(DMA, SRC, src);
    HW_WR(DMA, DST, dst);
    HW_WR(DMA, LEN, len);
    HW_WR(DMA, CTRL, 1u);
    if (HW_RD(DMA, STATUS) & 0x2u) {
        dl_dma_done_cb(2u);
    }
}

void dl_dma_done_cb(uint32_t status)
{
    if (status & 0x2u) {
        s_dma_retries++;
        drv_dma_start(0u, 0u, 0u);
    }
}
