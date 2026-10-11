/* Interrupt entry helpers (vendor style: ISR entries are declared through a macro). */
#ifndef HAL_ISR_H
#define HAL_ISR_H
#include <stdint.h>

#define ISR_ENTRY(name)   void name(void)
#define ISR_PRIO_HIGH     3u
#define ISR_PRIO_NORMAL   5u

static inline uint32_t irq_lock(void)
{
    return 0u;
}

static inline void irq_unlock(uint32_t key)
{
    (void)key;
}

#endif
