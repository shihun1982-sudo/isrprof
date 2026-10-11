/* Core 1 - PDCCH: CORESET de-mapping, polar blind decoding over the search space, DCI parsing.
 * Runs from DL_PDCCH_ISR once the CORESET symbols are through the FFT.
 */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "dl_drv.h"
#include "dl_phy.h"

#define PDCCH_CANDIDATES   4u

static uint32_t s_dci_raw[PDCCH_CANDIDATES];
static uint32_t s_blind_decodes;
static uint8_t  s_grant_idx;

static void pdcch_demap_coreset(void)
{
    drv_demap_start(2u, 8u);                      /* QPSK LLRs for the CORESET REs */
}

static uint8_t pdcch_blind_decode(void)
{
    uint8_t found = 0u;
    for (uint8_t c = 0u; c < PDCCH_CANDIDATES; c++) {
        drv_polar_decode(c, 8u, &s_dci_raw[c]);
        s_blind_decodes++;
        if ((s_dci_raw[c] & 0xFFFFu) == 0xC0DEu) {   /* RNTI-masked CRC passes */
            found = c + 1u;
            break;
        }
    }
    return found;
}

static void pdcch_parse_dci(uint32_t raw, dl_grant_t *g)
{
    g->valid     = 1u;
    g->harq_id   = (uint8_t)((raw >> 16) & 0xFu);
    g->rv        = (uint8_t)((raw >> 20) & 0x3u);
    g->ndi       = (uint8_t)((raw >> 22) & 0x1u);
    g->mcs       = (uint8_t)((raw >> 23) & 0x1Fu);
    g->mod_order = (g->mcs > 16u) ? 6u : ((g->mcs > 9u) ? 4u : 2u);
    g->layers    = 2u;
    g->tbs       = 8192u;
    g->prb_start = 0u;
    g->prb_len   = 52u;
    g->dmrs_sym_mask = 0x0804u;
    g->scr_seed  = raw ^ 0xA5A5A5A5u;
}

static void pdcch_notify_l1c(const dl_grant_t *g)
{
    IPC_SEND(CH_DL_TO_L1C, g);
}

void dl_pdcch_run(void)
{
    uint8_t cand;
    pdcch_demap_coreset();
    cand = pdcch_blind_decode();
    if (cand != 0u) {
        dl_grant_t *g = &g_dl_grant[s_grant_idx];
        s_grant_idx ^= 1u;
        pdcch_parse_dci(s_dci_raw[cand - 1u], g);
        pdcch_notify_l1c(g);
    }
}
