#ifndef MEAS_DRV_H
#define MEAS_DRV_H
#include <stdint.h>

void     drv_csirs_start(uint32_t cfg);
uint32_t drv_csirs_read_rsrp(void);
void     drv_ssb_pss_start(void);
uint32_t drv_ssb_sss_detect(void);
void     drv_rfic_set_afc(int32_t fo_hz);
void     drv_pbch_polar_decode(uint32_t *mib);

#endif
