/* Core 3 - CSI: CSI-RS measurement and CQI / PMI / RI report generation for the UL core. */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "meas_drv.h"
#include "meas.h"

static uint32_t s_csirs_cfg = 0x0211u;
static uint32_t s_rsrp_hist[4];
static uint8_t  s_hist_idx;

static uint8_t csi_cqi_from_sinr(int32_t sinr_db)
{
    if (sinr_db > 20) {
        return 15u;
    }
    if (sinr_db < -6) {
        return 1u;
    }
    return (uint8_t)((sinr_db + 6) / 2 + 1);
}

static void csi_compute_report(uint32_t rsrp)
{
    int32_t sinr_db;
    s_rsrp_hist[s_hist_idx] = rsrp;
    s_hist_idx = (uint8_t)((s_hist_idx + 1u) & 3u);
    sinr_db = (int32_t)(rsrp >> 24) - 10 - (int32_t)(g_chest_result.noise >> 14);
    g_csi_report.cqi   = csi_cqi_from_sinr(sinr_db);
    g_csi_report.pmi   = (uint8_t)(rsrp & 0x7u);
    g_csi_report.ri    = (sinr_db > 12) ? 2u : 1u;
    g_csi_report.valid = 1u;                                 /* consumed by core 2 (PUCCH) */
}

void csi_measure_and_report(void)
{
    drv_csirs_start(s_csirs_cfg);
    csi_compute_report(drv_csirs_read_rsrp());
}
