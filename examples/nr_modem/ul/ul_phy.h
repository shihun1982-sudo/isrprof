#ifndef UL_PHY_H
#define UL_PHY_H
#include <stdint.h>

void ul_fe_symbol(uint8_t sym);
void ul_pusch_prepare(void);
void ul_pucch_prepare(void);
void ul_srs_prepare(void);

#endif
