/* Core 1 - DL PHY drivers (FFT / channel estimator / LDPC decoder / DMA). */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "../l1c/sched.h"
#include "dl_drv.h"

static uint32_t s_dma_retries;      /* file-static */
static uint32_t s_fft_size_cached;

void drv_fft_configure(uint32_t size)
{
    if (s_fft_size_cached != size) {
        HW_WR(FFT, SIZE, size);
        s_fft_size_cached = size;
    }
    HW_RMW(FFT, CTRL, 0x3u, 0x1u);
}

void drv_fft_start(void)
{
    HW_WR(FFT, START, 1u);
}

void drv_chest_start(uint32_t prb_mask)
{
    HW_WR(CHEST, CTRL, prb_mask);
    HW_WR(CHEST, START, 1u);
}

void drv_ldpc_start(uint8_t bg, uint32_t tbs, uint8_t *softbits)
{
    HW_WR(LDPC, BG, bg);
    HW_WR(LDPC, CTRL, tbs);
    drv_dma_start((uint32_t)softbits, LDPC_BASE + 0x1000u, tbs);
    HW_WR(LDPC, START, 1u);
}

uint32_t drv_ldpc_poll(void)
{
    return HW_RD(LDPC, STATUS) & 0x1u;
}

/* Intentional structural smell #1: HAL-level wait calling *up* into the L1C scheduler. */
void hal_ldpc_wait(void)
{
    uint32_t iter = HW_RD(LDPC, ITER);
    if (iter > 20u) {
        sched_notify_late(iter);
    }
}

/* Intentional structural smell #2: a tangle (drv_dma_start <-> dl_dma_done_cb). */
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
        drv_dma_start(0u, 0u, 0u);   /* retry: creates a cycle */
    }
}
