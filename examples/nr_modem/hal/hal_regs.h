/* NR modem HAL: memory-mapped RX / TX chain blocks.
 *
 * All register traffic goes through HW_RD / HW_WR / HW_RMW / HW_POLL so that the profiler can
 * attribute every access to (block, register, read|write) and check it against the block deadline.
 *
 *   RX chain : RFIC -> DFE_RX -> FFT -> CHEST -> EQ -> DEMAP -> DESCR -> RDM/HARQ_BUF -> LDPC_DEC -> CRC
 *   control  : POLAR (PDCCH), CSIRS, SSB (cell search / tracking), TIMER, MBOX, DMA
 *   TX chain : ULENC (CRC+LDPC enc+rate match+scramble+mod) / UCI_ENC / SRS -> MAP -> IFFT -> DFE_TX -> RFIC
 */
#ifndef HAL_REGS_H
#define HAL_REGS_H
#include <stdint.h>

#define TIMER_BASE     0x50000000u
#define MBOX_BASE      0x50001000u
#define DMA_BASE       0x50002000u
#define RFIC_BASE      0x50003000u
#define DFE_RX_BASE    0x50010000u
#define FFT_BASE       0x50011000u
#define CHEST_BASE     0x50012000u
#define EQ_BASE        0x50013000u
#define DEMAP_BASE     0x50014000u
#define DESCR_BASE     0x50015000u
#define RDM_BASE       0x50016000u
#define HARQ_BUF_BASE  0x50017000u
#define LDPC_DEC_BASE  0x50018000u
#define CRC_BASE       0x50019000u
#define POLAR_BASE     0x5001A000u
#define CSIRS_BASE     0x5001B000u
#define SSB_BASE       0x5001C000u
#define ULENC_BASE     0x50020000u
#define UCI_ENC_BASE   0x50021000u
#define SRS_BASE       0x50022000u
#define MAP_BASE       0x50023000u
#define IFFT_BASE      0x50024000u
#define DFE_TX_BASE    0x50025000u

/* register offsets: <BLOCK>_<REG> */
#define TIMER_SFN 0x00u
#define TIMER_SLOT 0x04u
#define TIMER_SYM 0x08u
#define TIMER_CMP0 0x0Cu
#define TIMER_CMP1 0x10u
#define TIMER_CORR 0x14u
#define MBOX_TX 0x00u
#define MBOX_RX 0x04u
#define MBOX_STATUS 0x08u
#define MBOX_IRQ_CLR 0x0Cu
#define DMA_SRC 0x00u
#define DMA_DST 0x04u
#define DMA_LEN 0x08u
#define DMA_CTRL 0x0Cu
#define DMA_STATUS 0x10u
#define RFIC_RSSI 0x00u
#define RFIC_RX_GAIN 0x04u
#define RFIC_TX_GAIN 0x08u
#define RFIC_AFC 0x0Cu
#define RFIC_TA 0x10u
#define RFIC_TX_GATE 0x14u
#define RFIC_PA_CTRL 0x18u
#define DFE_RX_CTRL 0x00u
#define DFE_RX_DCOC 0x04u
#define DFE_RX_IQCORR 0x08u
#define DFE_RX_DECIM 0x0Cu
#define DFE_RX_START 0x10u
#define FFT_CTRL 0x00u
#define FFT_SIZE 0x04u
#define FFT_CP_LEN 0x08u
#define FFT_START 0x0Cu
#define FFT_STATUS 0x10u
#define CHEST_CTRL 0x00u
#define CHEST_DMRS_CFG 0x04u
#define CHEST_START 0x08u
#define CHEST_STATUS 0x0Cu
#define CHEST_NOISE 0x10u
#define CHEST_TO_EST 0x14u
#define CHEST_FO_EST 0x18u
#define EQ_CTRL 0x00u
#define EQ_MODE 0x04u
#define EQ_START 0x08u
#define EQ_STATUS 0x0Cu
#define DEMAP_CTRL 0x00u
#define DEMAP_MOD_ORDER 0x04u
#define DEMAP_LLR_SCALE 0x08u
#define DEMAP_START 0x0Cu
#define DEMAP_STATUS 0x10u
#define DESCR_CTRL 0x00u
#define DESCR_SEED 0x04u
#define DESCR_START 0x08u
#define RDM_CTRL 0x00u
#define RDM_RV 0x04u
#define RDM_START 0x08u
#define RDM_STATUS 0x0Cu
#define HARQ_BUF_BASE_ADDR 0x00u
#define HARQ_BUF_CTRL 0x04u
#define HARQ_BUF_COMBINE 0x08u
#define HARQ_BUF_FLUSH 0x0Cu
#define LDPC_DEC_CTRL 0x00u
#define LDPC_DEC_BG 0x04u
#define LDPC_DEC_ITER_MAX 0x08u
#define LDPC_DEC_START 0x0Cu
#define LDPC_DEC_STATUS 0x10u
#define LDPC_DEC_ITER_CNT 0x14u
#define CRC_CTRL 0x00u
#define CRC_START 0x04u
#define CRC_RESULT 0x08u
#define POLAR_CTRL 0x00u
#define POLAR_LIST_SIZE 0x04u
#define POLAR_START 0x08u
#define POLAR_STATUS 0x0Cu
#define POLAR_OUT 0x10u
#define CSIRS_CTRL 0x00u
#define CSIRS_CFG 0x04u
#define CSIRS_START 0x08u
#define CSIRS_STATUS 0x0Cu
#define CSIRS_RSRP 0x10u
#define SSB_CTRL 0x00u
#define SSB_PSS_START 0x04u
#define SSB_SSS_START 0x08u
#define SSB_STATUS 0x0Cu
#define SSB_PEAK 0x10u
#define ULENC_CTRL 0x00u
#define ULENC_BG 0x04u
#define ULENC_TBS 0x08u
#define ULENC_RV 0x0Cu
#define ULENC_SCR_SEED 0x10u
#define ULENC_MOD_ORDER 0x14u
#define ULENC_START 0x18u
#define ULENC_STATUS 0x1Cu
#define UCI_ENC_CTRL 0x00u
#define UCI_ENC_LEN 0x04u
#define UCI_ENC_START 0x08u
#define UCI_ENC_STATUS 0x0Cu
#define SRS_CTRL 0x00u
#define SRS_SEQ 0x04u
#define SRS_START 0x08u
#define MAP_CTRL 0x00u
#define MAP_PRB_START 0x04u
#define MAP_PRB_LEN 0x08u
#define MAP_DMRS_POS 0x0Cu
#define MAP_START 0x10u
#define IFFT_CTRL 0x00u
#define IFFT_SIZE 0x04u
#define IFFT_CP_LEN 0x08u
#define IFFT_START 0x0Cu
#define IFFT_STATUS 0x10u
#define DFE_TX_CTRL 0x00u
#define DFE_TX_UPSAMP 0x04u
#define DFE_TX_DPD 0x08u
#define DFE_TX_START 0x0Cu

#define HW_REG(block, reg)         (*(volatile uint32_t *)((block##_BASE) + (block##_##reg)))
#define HW_WR(block, reg, val)     (HW_REG(block, reg) = (uint32_t)(val))
#define HW_RD(block, reg)          (HW_REG(block, reg))
#define HW_RMW(block, reg, m, v)   (HW_REG(block, reg) = (HW_REG(block, reg) & ~(uint32_t)(m)) | ((uint32_t)(v) & (uint32_t)(m)))
/* busy-wait until (reg & mask) != 0 : a read in a loop (listed as a read macro in the config) */
#define HW_POLL(block, reg, mask)  do { while ((HW_REG(block, reg) & (uint32_t)(mask)) == 0u) { } } while (0)

#endif
