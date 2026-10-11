#ifndef DL_DRV_H
#define DL_DRV_H
#include <stdint.h>
void drv_fft_configure(uint32_t size);
void drv_fft_start(void);
void drv_chest_start(uint32_t prb_mask);
void drv_ldpc_start(uint8_t bg, uint32_t tbs, uint8_t *softbits);
uint32_t drv_ldpc_poll(void);
void drv_dma_start(uint32_t src, uint32_t dst, uint32_t len);
void dl_dma_done_cb(uint32_t status);
void hal_ldpc_wait(void);
#endif
