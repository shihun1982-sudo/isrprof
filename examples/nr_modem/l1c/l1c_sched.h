#ifndef L1C_SCHED_H
#define L1C_SCHED_H
#include "../common/l1_types.h"

void l1c_schedule_slot(uint8_t slot);
void l1c_harq_tick(void);
void l1c_on_dci(const dl_grant_t *dl, uint8_t slot);
void sched_notify_late(uint32_t where);
void mac_if_indicate(uint32_t ind, uint32_t arg);

#endif
