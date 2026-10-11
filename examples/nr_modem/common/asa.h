/* Air-interface State Area (ASA): a platform-level shared structure.
 * Its definition lives in the platform library (not part of these sources); the firmware reaches it
 * either directly (ASA.dl.harq_ack) or through the ASA_GET / ASA_SET accessor macros.  Both forms are
 * tracked by the profiler because `ASA` and the macros are registered in the config (memory.globals /
 * memory.access_macros).
 */
#ifndef ASA_H
#define ASA_H
#include <stdint.h>

#define ASA_GET(field)        (ASA.field)
#define ASA_SET(field, value) (ASA.field = (value))

/* legacy register macro with an unusual argument layout: (register, mask-unused, block) */
#define REGISTER_READ(reg, mask, block)  HW_REG(block, reg)

#endif
