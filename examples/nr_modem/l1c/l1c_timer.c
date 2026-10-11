/* Core 0 - L1 control: frame timer / slot tick interrupt.
 * Fires one symbol before every NW slot boundary (slot_tick lane): latch SFN/slot, apply the
 * timing correction computed by the tracking loop on core 3, run the slot scheduler, re-arm.
 */
#include "../hal/hal_regs.h"
#include "../hal/hal_isr.h"
#include "../common/shared_mem.h"
#include "l1c_sched.h"

static uint32_t s_tick_count;
static int32_t  s_last_corr_tc;

static void timer_latch(void)
{
    g_nw_timing.sfn    = (uint16_t)HW_RD(TIMER, SFN);
    g_nw_timing.slot   = (uint8_t)HW_RD(TIMER, SLOT);
    g_nw_timing.symbol = 0u;
    s_tick_count++;
}

static void timer_apply_timing_corr(void)
{
    int32_t corr = g_track_state.ttl_acc >> 4;          /* produced on core 3 */
    if (corr != s_last_corr_tc) {
        HW_WR(TIMER, CORR, (uint32_t)corr);
        g_nw_timing.to_corr_tc = corr;
        s_last_corr_tc = corr;
    }
    g_nw_timing.fo_corr_hz = g_track_state.ftl_acc >> 6;
}

static void timer_arm_next(void)
{
    uint32_t cmp = HW_RD(TIMER, CMP0);
    HW_WR(TIMER, CMP0, cmp + 1u);
    HW_WR(TIMER, CMP1, cmp + 1u + (NUM_SYM_SLOT / 2u));  /* mid-slot compare for L1C_IPC_ISR */
}

ISR_ENTRY(slot_tick_isr)
{
    uint32_t key = irq_lock();
    timer_latch();
    timer_apply_timing_corr();
    l1c_schedule_slot(g_nw_timing.slot);
    l1c_harq_tick();
    timer_arm_next();
    irq_unlock(key);
}
