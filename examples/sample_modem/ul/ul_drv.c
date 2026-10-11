/* Core 2 - UL PHY drivers (RF front-end, LDPC encoder, IFFT). */
#include "../hal/hal_regs.h"
#include "ul_drv.h"

static uint32_t s_last_ta;

void drv_rf_apply_ta(uint32_t ta)
{
    if (ta != s_last_ta) {
        HW_WR(RF, TA, ta);
        s_last_ta = ta;
    }
}

void drv_rf_tx_gate(uint32_t on)
{
    HW_RMW(RF, TX_GATE, 0x1u, on);
}

void drv_ldpc_encode(uint32_t tbs, uint8_t mcs)
{
    HW_WR(LDPC, BG, (mcs > 10u) ? 1u : 2u);
    HW_WR(LDPC, CTRL, tbs | 0x80000000u);
    HW_WR(LDPC, START, 1u);
}

void drv_ifft_start(void)
{
    HW_WR(IFFT, CTRL, 0x1u);
    HW_WR(IFFT, START, 1u);
}
