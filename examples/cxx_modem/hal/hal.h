// C++ modem sample - HAL: register access macros (same layout as the C sample) and ISR entry macro.
#pragma once
#include <stdint.h>

#define FFT_BASE    0x50011000u
#define LDPC_BASE   0x50018000u
#define RFIC_BASE   0x50003000u
#define IFFT_BASE   0x50024000u
#define DMA_BASE    0x50002000u

#define FFT_CTRL 0x0u
#define FFT_START 0x4u
#define FFT_STATUS 0x8u
#define LDPC_CTRL 0x0u
#define LDPC_START 0x4u
#define LDPC_STATUS 0x8u
#define RFIC_RX_GAIN 0x0u
#define RFIC_TA 0x4u
#define IFFT_CTRL 0x0u
#define IFFT_START 0x4u
#define DMA_SRC 0x0u
#define DMA_CTRL 0x4u

#define HW_REG(block, reg)        (*(volatile uint32_t *)((block##_BASE) + (block##_##reg)))
#define HW_WR(block, reg, val)    (HW_REG(block, reg) = (uint32_t)(val))
#define HW_RD(block, reg)         (HW_REG(block, reg))
#define HW_POLL(block, reg, mask) do { while ((HW_REG(block, reg) & (uint32_t)(mask)) == 0u) { } } while (0)

#define ISR_ENTRY(name) extern "C" void name(void)
