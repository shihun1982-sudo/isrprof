#ifndef UL_DRV_H
#define UL_DRV_H
#include <stdint.h>
void drv_rf_apply_ta(uint32_t ta);
void drv_rf_tx_gate(uint32_t on);
void drv_ldpc_encode(uint32_t tbs, uint8_t mcs);
void drv_ifft_start(void);
#endif
