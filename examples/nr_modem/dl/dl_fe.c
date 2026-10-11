/* Core 1 - DL front end, runs every symbol from DL_SYMBOL_ISR:
 * DFE configuration, FFT kick for the symbol that just landed in the sample buffer, AGC loop.
 */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "../common/asa.h"
#include "dl_drv.h"
#include "dl_phy.h"

typedef struct { int16_t target_dbm; int16_t rssi_dbm; uint8_t gain; uint8_t locked; } agc_t;

static agc_t    s_agc = { -60, 0, 32u, 0u };
static uint32_t s_sym_count;

static uint16_t dl_fe_cp_len(uint8_t sym)
{
    return (sym == 0u || sym == 7u) ? 352u : 288u;     /* long CP on symbols 0 and 7 (mu = 1) */
}

void dl_fe_symbol_start(uint8_t sym)
{
    drv_dfe_rx_config(sym);
    if (REGISTER_READ(DCOC, , DFE_RX) & 0x8000u) {         /* legacy macro: (reg, mask, block) */
        ASA_SET(dl.dcoc_overflow, 1u);                      /* accessor macro -> write ASA.dl.dcoc_overflow */
    }
    drv_fft_kick(sym, dl_fe_cp_len(sym));
    ASA.dl.symbol_count = ++s_sym_count;                    /* direct write to the registered structure */
}

void dl_fe_agc_update(void)
{
    s_agc.rssi_dbm = drv_rfic_read_rssi();
    s_agc.target_dbm = (int16_t)ASA_GET(dl.agc_target_dbm);  /* accessor macro -> read ASA.dl.agc_target_dbm */
    if (s_agc.rssi_dbm > s_agc.target_dbm + 3) {
        s_agc.gain -= 2u;
    } else if (s_agc.rssi_dbm < s_agc.target_dbm - 3) {
        s_agc.gain += 2u;
    } else {
        s_agc.locked = 1u;
    }
    drv_rfic_set_rx_gain(s_agc.gain);
    g_rf_state.rx_gain    = s_agc.gain;          /* consumed by the UL core for TX power */
    g_rf_state.rssi_dbm   = s_agc.rssi_dbm;
    g_rf_state.agc_locked = s_agc.locked;
}
