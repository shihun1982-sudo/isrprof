/* Core 2 - UL PHY drivers for the TX chain:
 *   ULENC (CRC + LDPC enc + rate match + scramble + modulate) / UCI_ENC / SRS -> MAP -> IFFT -> DFE_TX -> RFIC
 */
#include "../hal/hal_regs.h"
#include "ul_drv.h"

static uint32_t s_last_ta;
static uint8_t  s_last_tx_gain;

void drv_rfic_set_ta(uint32_t ta_tc)
{
    if (ta_tc != s_last_ta) {
        HW_WR(RFIC, TA, ta_tc);
        s_last_ta = ta_tc;
    }
}

void drv_rfic_tx_gate(uint32_t on)
{
    HW_RMW(RFIC, TX_GATE, 0x1u, on);
    HW_RMW(RFIC, PA_CTRL, 0x3u, on ? 0x3u : 0x0u);
}

void drv_rfic_set_tx_gain(uint8_t gain)
{
    if (gain != s_last_tx_gain) {
        HW_WR(RFIC, TX_GAIN, gain);
        s_last_tx_gain = gain;
    }
}

void drv_dfe_tx_kick(uint8_t sym)
{
    HW_WR(DFE_TX, UPSAMP, 2u);
    HW_RMW(DFE_TX, DPD, 0x1u, 0x1u);
    HW_WR(DFE_TX, START, 1u | ((uint32_t)sym << 8));
}

void drv_ifft_start(uint8_t sym, uint16_t cp_len)
{
    HW_WR(IFFT, CP_LEN, cp_len);
    HW_WR(IFFT, CTRL, sym);
    HW_WR(IFFT, START, 1u);
}

void drv_ulenc_run(uint8_t bg, uint16_t tbs, uint8_t rv, uint32_t seed, uint8_t mod_order)
{
    HW_WR(ULENC, BG, bg);
    HW_WR(ULENC, TBS, tbs);
    HW_WR(ULENC, RV, rv);
    HW_WR(ULENC, SCR_SEED, seed);
    HW_WR(ULENC, MOD_ORDER, mod_order);
    HW_WR(ULENC, START, 1u);
    HW_POLL(ULENC, STATUS, 0x1u);
}

void drv_uci_encode(uint32_t bits, uint8_t len)
{
    HW_WR(UCI_ENC, LEN, len);
    HW_WR(UCI_ENC, CTRL, bits);
    HW_WR(UCI_ENC, START, 1u);
    HW_POLL(UCI_ENC, STATUS, 0x1u);
}

void drv_map_pusch(uint16_t prb_start, uint16_t prb_len, uint16_t dmrs_pos)
{
    HW_WR(MAP, PRB_START, prb_start);
    HW_WR(MAP, PRB_LEN, prb_len);
    HW_WR(MAP, DMRS_POS, dmrs_pos);
    HW_WR(MAP, START, 1u);
}

void drv_map_pucch(uint16_t prb, uint8_t fmt)
{
    HW_WR(MAP, CTRL, 0x100u | fmt);
    HW_WR(MAP, PRB_START, prb);
    HW_WR(MAP, START, 1u);
}

void drv_srs_start(uint32_t seq)
{
    HW_WR(SRS, SEQ, seq);
    HW_WR(SRS, START, 1u);
}

void drv_ul_dma(uint32_t src, uint32_t dst, uint32_t len)
{
    HW_WR(DMA, SRC, src);
    HW_WR(DMA, DST, dst);
    HW_WR(DMA, LEN, len);
    HW_WR(DMA, CTRL, 1u);
}
