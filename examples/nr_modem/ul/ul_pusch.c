/* Core 2 - PUSCH preparation for the next slot (UL_TX_PREP_ISR):
 * grant from L1C -> transport block from the MAC queue -> ULENC -> DMRS -> RE mapping -> DMA to IFFT buffer.
 */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "ul_drv.h"
#include "ul_phy.h"

static ul_grant_t s_ul_grant;
static uint8_t    s_tbq_rd;
static uint16_t   s_dmrs_table[NUM_SYM_SLOT];
static uint32_t   s_tb_sent;

static void ul_fetch_grant(void)
{
    IPC_RECV(CH_L1C_TO_UL, &s_ul_grant);
}

static tb_desc_t *ul_tb_fetch(void)
{
    tb_desc_t *tb = &g_ul_tb_queue[s_tbq_rd];
    if (!tb->valid) {
        return 0;
    }
    s_tbq_rd = (uint8_t)((s_tbq_rd + 1u) % TB_QUEUE_LEN);
    return tb;
}

static void ul_encode_tb(const tb_desc_t *tb)
{
    uint8_t bg = (s_ul_grant.mcs > 10u) ? 1u : 2u;
    drv_ulenc_run(bg, tb->len, s_ul_grant.rv, s_ul_grant.scr_seed, s_ul_grant.mod_order);
}

static uint16_t ul_dmrs_gen(void)
{
    static uint32_t gold_state = 0x1u;            /* function-static sequence state */
    gold_state = (gold_state * 1103515245u + 12345u);
    s_dmrs_table[2] = (uint16_t)(gold_state >> 16);
    s_dmrs_table[11] = (uint16_t)(gold_state & 0xFFFFu);
    return 0x0804u;
}

static void ul_map_and_dma(const tb_desc_t *tb, uint16_t dmrs_pos)
{
    drv_map_pusch(s_ul_grant.prb_start, s_ul_grant.prb_len, dmrs_pos);
    drv_ul_dma((uint32_t)tb->data, IFFT_BASE + 0x1000u, tb->len);
}

void ul_pusch_prepare(void)
{
    tb_desc_t *tb;
    ul_fetch_grant();
    if (!s_ul_grant.valid) {
        return;
    }
    tb = ul_tb_fetch();
    if (tb == 0) {
        return;
    }
    ul_encode_tb(tb);
    ul_map_and_dma(tb, ul_dmrs_gen());
    pool_free(tb->data);
    tb->valid = 0u;
    s_tb_sent++;
}
