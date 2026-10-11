#ifndef DL_PHY_H
#define DL_PHY_H
#include <stdint.h>
#include "../common/l1_types.h"

/* dl_fe.c : per-symbol front end */
void dl_fe_symbol_start(uint8_t sym);
void dl_fe_agc_update(void);
/* dl_chest.c */
void dl_chest_kick(uint8_t sym);
void dl_chest_collect(void);
void dl_eq_prepare(const dl_grant_t *g);
/* dl_pdcch.c */
void dl_pdcch_run(void);
/* dl_pdsch.c */
void dl_pdsch_run(void);

#endif
