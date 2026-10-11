/* Core 3 - measurement / sync interrupt entries.
 *   track_isr : once per slot, after the DL channel estimate   - TTL / FTL update, AFC
 *   csirs_isr : every 5 slots (CSI-RS periodicity)              - CSI-RS measurement -> CSI report
 *   ssb_isr   : every 10 slots (SSB half frame)                 - PSS/SSS, PBCH, cell measurement
 */
#include "../hal/hal_regs.h"
#include "../hal/hal_isr.h"
#include "../common/shared_mem.h"
#include "meas.h"

static uint32_t s_track_runs;

ISR_ENTRY(track_isr)
{
    sync_track_update();
    s_track_runs++;
}

ISR_ENTRY(csirs_isr)
{
    csi_measure_and_report();
}

ISR_ENTRY(ssb_isr)
{
    sync_ssb_search();
}
