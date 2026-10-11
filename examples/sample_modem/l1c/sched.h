#ifndef SCHED_H
#define SCHED_H
#include <stdint.h>
void l1c_schedule_slot(uint8_t slot);
void sched_notify_late(uint32_t where);
#endif
