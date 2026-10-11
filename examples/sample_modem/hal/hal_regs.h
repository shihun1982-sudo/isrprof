/* HAL register access macros for the sample NR modem.
 * Every HW access in the firmware goes through these, which is what lets the
 * profiler attribute read/write/block per function.
 */
#ifndef HAL_REGS_H
#define HAL_REGS_H
#include <stdint.h>

#define FFT_BASE        0x40010000u
#define LDPC_BASE       0x40020000u
#define DMA_BASE        0x40030000u
#define RF_BASE         0x40040000u
#define TIMER_BASE      0x40050000u
#define CHEST_BASE      0x40060000u
#define IFFT_BASE       0x40070000u

/* register offsets (block##_##reg) */
#define FFT_CTRL        0x00u
#define FFT_SIZE        0x04u
#define FFT_START       0x08u
#define FFT_STATUS      0x0Cu
#define LDPC_CTRL       0x00u
#define LDPC_BG         0x04u
#define LDPC_START      0x08u
#define LDPC_STATUS     0x0Cu
#define LDPC_ITER       0x10u
#define DMA_SRC         0x00u
#define DMA_DST         0x04u
#define DMA_LEN         0x08u
#define DMA_CTRL        0x0Cu
#define DMA_STATUS      0x10u
#define RF_TA           0x00u
#define RF_TX_GATE      0x04u
#define RF_GAIN         0x08u
#define TIMER_SFN       0x00u
#define TIMER_SLOT      0x04u
#define TIMER_SYM       0x08u
#define TIMER_CMP0      0x0Cu
#define CHEST_CTRL      0x00u
#define CHEST_START     0x04u
#define CHEST_STATUS    0x08u
#define IFFT_CTRL       0x00u
#define IFFT_START      0x04u

#define HW_REG(block, reg)        (*(volatile uint32_t *)((block##_BASE) + (block##_##reg)))
#define HW_WR(block, reg, val)    (HW_REG(block, reg) = (uint32_t)(val))
#define HW_RD(block, reg)         (HW_REG(block, reg))
#define HW_RMW(block, reg, m, v)  (HW_REG(block, reg) = (HW_REG(block, reg) & ~(uint32_t)(m)) | ((uint32_t)(v) & (uint32_t)(m)))

#endif
