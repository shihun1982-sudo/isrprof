/* Shared memory between the four L1 cores + IPC / heap primitives.
 *
 * core 0 L1C writes timing + grants, core 1 DL writes HARQ-ACK / chest results, core 2 UL consumes
 * grants / ACKs / CSI, core 3 MEAS writes tracking + CSI + measurements.
 */
#ifndef SHARED_MEM_H
#define SHARED_MEM_H
#include "l1_types.h"

/* IPC channels (mailbox queues in shared SRAM) */
#define CH_MAC_TO_L1    0
#define CH_L1_TO_MAC    1
#define CH_L1C_TO_DL    2
#define CH_L1C_TO_UL    3
#define CH_DL_TO_L1C    4
#define CH_DL_TO_UL     5
#define CH_MEAS_TO_L1C  6
#define CH_L1C_TO_MEAS  7

#define IPC_SEND(ch, msg)   ipc_post((ch), (const void *)(msg))
#define IPC_RECV(ch, msg)   ipc_fetch((ch), (void *)(msg))

extern volatile nw_timing_t g_nw_timing;         /* core0 -> all                     */
extern dl_grant_t           g_dl_grant[2];       /* core1 (DCI) -> core1 PDSCH, core0 */
extern ul_grant_t           g_ul_grant[2];       /* core0 -> core2                   */
extern harq_ack_t           g_dl_harq_ack;       /* core1 -> core2 (PUCCH), core0    */
extern csi_report_t         g_csi_report;        /* core3 -> core2                   */
extern meas_result_t        g_meas_result;       /* core3 -> core0                   */
extern chest_result_t       g_chest_result;      /* core1 -> core3                   */
extern track_state_t        g_track_state;       /* core3 -> core0, core2            */
extern rf_state_t           g_rf_state;          /* core1 AGC -> core2 TX power      */
extern tb_desc_t            g_ul_tb_queue[TB_QUEUE_LEN]; /* core0 (MAC) -> core2      */
extern tb_desc_t            g_dl_tb_out[2];      /* core1 -> MAC                     */
extern uint8_t             *g_harq_soft[NUM_HARQ]; /* soft-bit buffers, heap allocated */

int   ipc_post(int ch, const void *msg);
int   ipc_fetch(int ch, void *msg);
void *pool_alloc(uint32_t bytes);
void  pool_free(void *p);

#endif
