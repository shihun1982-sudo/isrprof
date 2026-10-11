/* Core 3 - synchronisation: TTL / FTL tracking loops fed by the DL channel estimator, SSB search. */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "meas_drv.h"
#include "meas.h"

static int32_t  s_ttl_gain = 8;
static int32_t  s_ftl_gain = 4;
static uint32_t s_ssb_count;
static uint32_t s_mib;

static void sync_ttl_update(void)
{
    if (g_chest_result.valid) {
        g_track_state.ttl_acc += g_chest_result.to_est_tc / s_ttl_gain;    /* consumed by core 0 (timer) and core 2 (TA) */
    }
}

static void sync_ftl_update(void)
{
    if (g_chest_result.valid) {
        g_track_state.ftl_acc += g_chest_result.fo_est_hz / s_ftl_gain;
        drv_rfic_set_afc(g_track_state.ftl_acc >> 6);
    }
    g_track_state.locked = (g_track_state.ftl_acc < 2000 && g_track_state.ftl_acc > -2000) ? 1u : 0u;
}

void sync_track_update(void)
{
    sync_ttl_update();
    sync_ftl_update();
}

static void sync_measure_cell(uint32_t peak)
{
    g_meas_result.rsrp_dbm = (int16_t)(-140 + (int32_t)(peak >> 20));
    g_meas_result.sinr_db  = (int16_t)((int32_t)(peak >> 24) - 10);
    g_meas_result.pci      = (uint16_t)(peak & 0x3FFu);
    g_meas_result.valid    = 1u;
}

void sync_ssb_search(void)
{
    uint32_t peak;
    drv_ssb_pss_start();
    peak = drv_ssb_sss_detect();
    sync_measure_cell(peak);
    drv_pbch_polar_decode(&s_mib);
    IPC_SEND(CH_MEAS_TO_L1C, &g_meas_result);
    s_ssb_count++;
}
