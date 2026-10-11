/* Core 2 - UL PHY interrupt entries (UL timing line = NW + timing advance). */
#include "../hal/hal_regs.h"
#include "../hal/hal_isr.h"
#include "../common/shared_mem.h"
#include "ul_phy.h"

static uint8_t s_ul_sym;

ISR_ENTRY(ul_symbol_isr)
{
    ul_fe_symbol(s_ul_sym);
    s_ul_sym = (uint8_t)((s_ul_sym + 1u) % NUM_SYM_SLOT);
}

ISR_ENTRY(ul_tx_prep_isr)
{
    ul_pusch_prepare();
}

ISR_ENTRY(ul_pucch_isr)
{
    ul_pucch_prepare();
}

ISR_ENTRY(ul_srs_isr)
{
    ul_srs_prepare();
}
