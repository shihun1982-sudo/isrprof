/* Core 2 - UL PHY interrupt handlers (UL timing lane = NW + timing advance). */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "ul_drv.h"

static ul_grant_t s_ul_grant;
static uint32_t   s_tx_count;

static void ul_ta_apply(void)
{
    drv_rf_apply_ta(g_timing_adv);           /* reads value produced on core 0 */
}

static void ul_fetch_grant(void)
{
    IPC_RECV(CH_L1C_TO_UL, &s_ul_grant);
}

void ul_symbol_isr(void)
{
    ul_ta_apply();
    drv_rf_tx_gate(1u);
    s_tx_count++;
}

static void ul_pusch_encode(void)
{
    drv_ldpc_encode(s_ul_grant.tbs, s_ul_grant.mcs);
    drv_ifft_start();
}

void ul_tx_prep_isr(void)
{
    ul_fetch_grant();
    ul_pusch_encode();
    drv_rf_tx_gate(0u);
}
