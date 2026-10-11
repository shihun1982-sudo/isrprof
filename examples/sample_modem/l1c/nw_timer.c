/* Core 0 - L1 control: NW timing / slot tick interrupt. */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "sched.h"

static uint32_t s_tick_count;

static void nw_timer_latch(void)
{
    g_nw_timing.sfn    = (uint16_t)HW_RD(TIMER, SFN);
    g_nw_timing.slot   = (uint8_t)HW_RD(TIMER, SLOT);
    g_nw_timing.symbol = 0;
    s_tick_count++;
}

static void nw_timer_arm_next(void)
{
    uint32_t cmp = HW_RD(TIMER, CMP0);
    HW_WR(TIMER, CMP0, cmp + 1u);
}

/* ISR entry: fires one symbol before the NW slot boundary (slot_tick lane). */
void slot_tick_isr(void)
{
    nw_timer_latch();
    l1c_schedule_slot(g_nw_timing.slot);
    nw_timer_arm_next();
}
