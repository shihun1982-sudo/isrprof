/* Core 1 - DL PHY interrupt entries.
 *   dl_symbol_isr : every symbol on the DL timing line  - DFE / FFT / AGC, CHEST on DMRS symbols
 *   dl_pdcch_isr  : once per slot after the CORESET     - PDCCH blind decode -> DCI -> L1C
 *   dl_pdsch_isr  : once per slot after the last symbol - PDSCH decode pipeline -> HARQ-ACK / TB
 */
#include "../hal/hal_regs.h"
#include "../hal/hal_isr.h"
#include "../common/shared_mem.h"
#include "dl_phy.h"

static uint8_t  s_sym_in_slot;
static uint32_t s_dmrs_mask = 0x0804u;     /* DMRS on symbols 2 and 11 */

static void dl_track_symbol(void)
{
    s_sym_in_slot = (uint8_t)((s_sym_in_slot + 1u) % NUM_SYM_SLOT);
    g_nw_timing.symbol = s_sym_in_slot;         /* writes the shared timing struct */
}

ISR_ENTRY(dl_symbol_isr)
{
    dl_track_symbol();
    dl_fe_symbol_start(s_sym_in_slot);
    if ((s_dmrs_mask >> s_sym_in_slot) & 1u) {
        dl_chest_kick(s_sym_in_slot);
    }
    if (s_sym_in_slot == 3u) {
        dl_chest_collect();
    }
    dl_fe_agc_update();
}

ISR_ENTRY(dl_pdcch_isr)
{
    dl_pdcch_run();
}

ISR_ENTRY(dl_pdsch_isr)
{
    dl_pdsch_run();
}
