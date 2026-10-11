/* Core 1 - channel estimation (DMRS symbols), noise estimation, equaliser setup. */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "dl_drv.h"
#include "dl_phy.h"

static uint16_t s_dmrs_cfg = 0x0203u;      /* type-1, 2 symbols */
static uint32_t s_chest_runs;

void dl_chest_kick(uint8_t sym)
{
    const dl_grant_t *g = &g_dl_grant[sym & 1u];
    uint32_t prb_mask = ((1u << (g->prb_len > 31u ? 31u : g->prb_len)) - 1u) << (g->prb_start & 31u);
    drv_chest_start(s_dmrs_cfg, prb_mask);
    s_chest_runs++;
}

void dl_chest_collect(void)
{
    drv_chest_read(&g_chest_result);              /* read by the tracking loop on core 3 */
}

void dl_eq_prepare(const dl_grant_t *g)
{
    uint8_t mode = (g->layers > 1u) ? 2u : 1u;    /* MMSE-IRC for rank 2 */
    if (g_chest_result.noise > 0x4000u) {
        mode = 1u;
    }
    drv_eq_config(mode, g->prb_start, g->prb_len);
}
