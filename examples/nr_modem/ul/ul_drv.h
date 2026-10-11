#ifndef UL_DRV_H
#define UL_DRV_H
#include <stdint.h>

void drv_rfic_set_ta(uint32_t ta_tc);
void drv_rfic_tx_gate(uint32_t on);
void drv_rfic_set_tx_gain(uint8_t gain);
void drv_dfe_tx_kick(uint8_t sym);
void drv_ifft_start(uint8_t sym, uint16_t cp_len);
void drv_ulenc_run(uint8_t bg, uint16_t tbs, uint8_t rv, uint32_t seed, uint8_t mod_order);
void drv_uci_encode(uint32_t bits, uint8_t len);
void drv_map_pusch(uint16_t prb_start, uint16_t prb_len, uint16_t dmrs_pos);
void drv_map_pucch(uint16_t prb, uint8_t fmt);
void drv_srs_start(uint32_t seq);
void drv_ul_dma(uint32_t src, uint32_t dst, uint32_t len);

#endif
