#ifndef SHARED_MEM_H
#define SHARED_MEM_H
#include <stdint.h>

#define CH_L1C_TO_DL   0
#define CH_L1C_TO_UL   1
#define CH_DL_TO_L1C   2

typedef struct {
    uint16_t sfn;
    uint8_t  slot;
    uint8_t  symbol;
    int32_t  ta_offset_tc;      /* timing advance in Tc */
} nw_timing_t;

typedef struct {
    uint8_t  harq_id;
    uint8_t  rv;
    uint16_t tbs;
    uint32_t prb_mask;
} dl_grant_t;

typedef struct {
    uint8_t  harq_id;
    uint16_t tbs;
    uint8_t  mcs;
} ul_grant_t;

typedef struct {
    dl_grant_t dl;
    ul_grant_t ul;
    uint8_t    valid;
} slot_ctx_t;

/* IPC: channel, pointer to message */
#define IPC_SEND(ch, msg)   ipc_post((ch), (const void *)(msg))
#define IPC_RECV(ch, msg)   ipc_fetch((ch), (void *)(msg))

extern volatile nw_timing_t g_nw_timing;      /* written by L1C, read by DL/UL cores */
extern slot_ctx_t           g_slot_ctx[2];    /* double-buffered grant context       */
extern uint32_t             g_timing_adv;     /* TA command, L1C -> UL core          */
extern uint8_t             *g_harq_pool[16];  /* soft-bit buffers (heap allocated)   */

int  ipc_post(int ch, const void *msg);
int  ipc_fetch(int ch, void *msg);
void *pool_alloc(uint32_t bytes);
void  pool_free(void *p);

#endif
