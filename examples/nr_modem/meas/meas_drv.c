/* Core 3 - measurement / synchronisation drivers (CSI-RS engine, SSB correlator, RFIC AFC, POLAR). */
#include "../hal/hal_regs.h"
#include "meas_drv.h"

static int32_t s_last_afc;

void drv_csirs_start(uint32_t cfg)
{
    HW_WR(CSIRS, CFG, cfg);
    HW_WR(CSIRS, CTRL, 0x1u);
    HW_WR(CSIRS, START, 1u);
}

uint32_t drv_csirs_read_rsrp(void)
{
    HW_POLL(CSIRS, STATUS, 0x1u);
    return HW_RD(CSIRS, RSRP);
}

void drv_ssb_pss_start(void)
{
    HW_WR(SSB, CTRL, 0x3u);
    HW_WR(SSB, PSS_START, 1u);
}

uint32_t drv_ssb_sss_detect(void)
{
    HW_WR(SSB, SSS_START, 1u);
    HW_POLL(SSB, STATUS, 0x2u);
    return HW_RD(SSB, PEAK);
}

void drv_rfic_set_afc(int32_t fo_hz)
{
    if (fo_hz != s_last_afc) {
        HW_WR(RFIC, AFC, (uint32_t)fo_hz);
        s_last_afc = fo_hz;
    }
}

/* PBCH uses the same POLAR decoder as PDCCH on core 1 (shared block, per-core deadline) */
void drv_pbch_polar_decode(uint32_t *mib)
{
    HW_WR(POLAR, LIST_SIZE, 8u);
    HW_WR(POLAR, CTRL, 0x80u);
    HW_WR(POLAR, START, 1u);
    HW_POLL(POLAR, STATUS, 0x1u);
    *mib = HW_RD(POLAR, OUT);
}
