/* Core 0 - MAC <-> L1 mailbox interface.
 *  mbox_isr    : MAC posted a message (UL transport block, configuration)
 *  l1c_ipc_isr : mid-slot IPC service (DCI from core 1, measurement reports from core 3)
 */
#include "../hal/hal_regs.h"
#include "../hal/hal_isr.h"
#include "../common/shared_mem.h"
#include "l1c_sched.h"

static uint32_t s_mbox_rx_count;
static uint8_t  s_tbq_wr;
static uint32_t s_cfg_word;

static void mac_if_fetch(mbox_msg_t *msg)
{
    msg->type = HW_RD(MBOX, RX);
    msg->arg0 = HW_RD(MBOX, RX);
    msg->arg1 = HW_RD(MBOX, RX);
    msg->arg2 = HW_RD(MBOX, RX);
    HW_WR(MBOX, IRQ_CLR, 1u);
    s_mbox_rx_count++;
}

static void mac_if_handle_ul_tb(const mbox_msg_t *msg)
{
    tb_desc_t *tb = &g_ul_tb_queue[s_tbq_wr];
    tb->len     = (uint16_t)msg->arg1;
    tb->harq_id = (uint8_t)msg->arg2;
    tb->data    = (uint8_t *)pool_alloc(tb->len);       /* heap in interrupt context */
    tb->valid   = 1u;
    s_tbq_wr = (uint8_t)((s_tbq_wr + 1u) % TB_QUEUE_LEN);
}

static void mac_if_handle_cfg(const mbox_msg_t *msg)
{
    s_cfg_word = msg->arg0;
    g_nw_timing.ta_tc = (int32_t)msg->arg1;
}

ISR_ENTRY(mbox_isr)
{
    mbox_msg_t msg;
    mac_if_fetch(&msg);
    switch (msg.type) {
    case MBOX_MSG_UL_TB:
        mac_if_handle_ul_tb(&msg);
        break;
    case MBOX_MSG_CFG:
        mac_if_handle_cfg(&msg);
        break;
    default:
        break;
    }
}

/* L1 -> MAC indication (also called from the DL core when a transport block is delivered) */
void mac_if_indicate(uint32_t ind, uint32_t arg)
{
    HW_WR(MBOX, TX, ind);
    HW_WR(MBOX, TX, arg);
    HW_RMW(MBOX, STATUS, 0x1u, 0x1u);
}

static void l1c_ipc_service_dl(void)
{
    dl_grant_t dl;
    if (IPC_RECV(CH_DL_TO_L1C, &dl) > 0) {
        l1c_on_dci(&dl, g_nw_timing.slot);
    }
}

static void l1c_ipc_service_meas(void)
{
    meas_result_t m;
    if (IPC_RECV(CH_MEAS_TO_L1C, &m) > 0) {
        mac_if_indicate(MBOX_IND_MEAS, (uint32_t)g_meas_result.rsrp_dbm);
    }
}

ISR_ENTRY(l1c_ipc_isr)
{
    l1c_ipc_service_dl();
    l1c_ipc_service_meas();
}
