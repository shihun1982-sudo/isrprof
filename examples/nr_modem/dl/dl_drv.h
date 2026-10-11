#ifndef DL_DRV_H
#define DL_DRV_H
#include <stdint.h>
#include "../common/l1_types.h"

/* RX front-end */
void     drv_dfe_rx_config(uint8_t sym);
void     drv_fft_kick(uint8_t sym, uint16_t cp_len);
int16_t  drv_rfic_read_rssi(void);
void     drv_rfic_set_rx_gain(uint8_t gain);
/* channel estimation / equalisation */
void     drv_chest_start(uint16_t dmrs_cfg, uint32_t prb_mask);
void     drv_chest_read(chest_result_t *out);
void     drv_eq_config(uint8_t mode, uint16_t prb_start, uint16_t prb_len);
/* PDCCH */
void     drv_polar_decode(uint8_t cand, uint8_t list_size, uint32_t *dci_out);
/* PDSCH pipeline */
void     drv_demap_start(uint8_t mod_order, uint8_t llr_scale);
void     drv_descr_start(uint32_t seed);
void     drv_rdm_start(uint8_t rv, uint16_t tbs);
void     drv_harq_combine(uint8_t harq_id, uint8_t *soft);
void     drv_ldpc_start(uint8_t bg, uint16_t tbs);
uint32_t drv_ldpc_poll(void);
void     hal_ldpc_wait(void);
uint32_t drv_crc_check(uint16_t tbs);
void     drv_dma_start(uint32_t src, uint32_t dst, uint32_t len);
void     dl_dma_done_cb(uint32_t status);

#endif
