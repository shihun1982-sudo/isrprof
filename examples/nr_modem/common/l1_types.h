#ifndef L1_TYPES_H
#define L1_TYPES_H
#include <stdint.h>

#define NUM_HARQ        16u
#define NUM_SYM_SLOT    14u
#define TB_QUEUE_LEN    4u

typedef struct {
    uint16_t sfn;
    uint8_t  slot;
    uint8_t  symbol;
    int32_t  ta_tc;          /* timing advance in Tc, from MAC / TA command */
    int32_t  to_corr_tc;     /* timing offset correction from the tracking loop (core 3) */
    int32_t  fo_corr_hz;     /* frequency offset correction (core 3)                    */
} nw_timing_t;

typedef struct {
    uint8_t  valid, harq_id, rv, mcs, mod_order, layers, ndi;
    uint16_t tbs, prb_start, prb_len;
    uint16_t dmrs_sym_mask;
    uint32_t scr_seed;
} dl_grant_t;

typedef struct {
    uint8_t  valid, harq_id, rv, mcs, mod_order, ndi;
    uint16_t tbs, prb_start, prb_len;
    uint32_t scr_seed;
    int8_t   tpc_db;
} ul_grant_t;

typedef struct { uint8_t harq_id, ack, valid; }                      harq_ack_t;
typedef struct { uint8_t cqi, pmi, ri, valid; }                      csi_report_t;
typedef struct { int16_t rsrp_dbm, rsrq_db, sinr_db; uint16_t pci; uint8_t valid; } meas_result_t;
typedef struct { uint8_t *data; uint16_t len; uint8_t harq_id, valid; } tb_desc_t;
typedef struct { uint8_t rx_gain, tx_gain, agc_locked; int16_t rssi_dbm; } rf_state_t;
typedef struct { uint32_t noise; int32_t to_est_tc; int32_t fo_est_hz; uint8_t valid; } chest_result_t;
typedef struct { int32_t ttl_acc; int32_t ftl_acc; uint8_t locked; }   track_state_t;

typedef struct {
    uint32_t type;
    uint32_t arg0, arg1, arg2;
} mbox_msg_t;

#define MBOX_MSG_UL_TB      1u
#define MBOX_MSG_CFG        2u
#define MBOX_IND_DL_TB      3u
#define MBOX_IND_MEAS       4u

#endif
