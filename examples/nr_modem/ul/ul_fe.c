/* Core 2 - UL front end, every symbol on the UL timing line (NW + timing advance):
 * TA / timing-correction apply, IFFT + DFE TX kick, TX gate and power for the symbol.
 */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "../common/asa.h"
#include "ul_drv.h"
#include "ul_phy.h"

static uint16_t s_tx_sym_mask = 0x3FFFu;     /* symbols carrying UL data this slot */
static uint32_t s_gate_count;

static void ul_fe_apply_ta(void)
{
    int32_t ta = g_nw_timing.ta_tc + (g_track_state.ttl_acc >> 8);    /* MAC TA + tracking loop (core 3) */
    drv_rfic_set_ta((uint32_t)ta);
}

static void ul_fe_power(void)
{
    const ul_grant_t *g = &g_ul_grant[g_nw_timing.slot & 1u];
    int32_t gain = 40 + g->tpc_db - (g_rf_state.rx_gain >> 3);        /* open loop from the DL AGC */
    if (gain > ASA.ul.max_tx_gain) {                                   /* read of the registered structure */
        gain = ASA.ul.max_tx_gain;
    }
    drv_rfic_set_tx_gain((uint8_t)gain);
}

void ul_fe_symbol(uint8_t sym)
{
    uint32_t on = (s_tx_sym_mask >> sym) & 1u;
    ul_fe_apply_ta();
    drv_ifft_start(sym, (sym == 0u || sym == 7u) ? 352u : 288u);
    drv_dfe_tx_kick(sym);
    if (on) {
        ul_fe_power();
    }
    drv_rfic_tx_gate(on);
    s_gate_count += on;
}
