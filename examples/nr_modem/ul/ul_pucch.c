/* Core 2 - PUCCH (UCI: HARQ-ACK from the DL core, CSI from the measurement core) and SRS. */
#include "../hal/hal_regs.h"
#include "../common/shared_mem.h"
#include "ul_drv.h"
#include "ul_phy.h"

static harq_ack_t s_ack_pending;
static uint32_t   s_uci_count;
static uint32_t   s_srs_seq = 0x2Cu;

static uint32_t ul_uci_build(uint8_t *len)
{
    uint32_t bits = 0u;
    *len = 0u;
    if (IPC_RECV(CH_DL_TO_UL, &s_ack_pending) > 0 && g_dl_harq_ack.valid) {
        bits |= (uint32_t)g_dl_harq_ack.ack;             /* HARQ-ACK bit from core 1 */
        *len += 1u;
    }
    if (g_csi_report.valid) {                             /* CQI / PMI / RI from core 3 */
        bits |= ((uint32_t)g_csi_report.cqi << 1) | ((uint32_t)g_csi_report.pmi << 5) | ((uint32_t)g_csi_report.ri << 8);
        *len += 9u;
    }
    return bits;
}

void ul_pucch_prepare(void)
{
    uint8_t len;
    uint32_t bits = ul_uci_build(&len);
    if (len == 0u) {
        return;
    }
    drv_uci_encode(bits, len);
    drv_map_pucch(0u, (len > 2u) ? 2u : 0u);
    s_uci_count++;
}

void ul_srs_prepare(void)
{
    s_srs_seq = (s_srs_seq * 7u + 1u) & 0x3FFu;
    drv_srs_start(s_srs_seq);
    drv_map_pucch(51u, 9u);                               /* SRS on the last symbol */
}
