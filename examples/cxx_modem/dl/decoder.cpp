// C++ modem sample - DL core: symbol ISR drives the FFT through a driver object, the PDSCH ISR runs
// the stage objects through their virtual interface and a function-pointer table.
#include "../hal/hal.h"
#include "decoder.h"

namespace dl {

static LdpcDecoder s_ldpc;
static CrcStage    s_crc;
static Stage      *s_stages[] = { &s_ldpc, &s_crc };
static uint32_t    s_symbols;

FftDriver &FftDriver::instance()
{
    static FftDriver inst;             // function-static object
    return inst;
}

void FftDriver::kick(uint8_t sym)
{
    uint16_t cp = (sym == 0u) ? 352u : 288u;
    if (cp != m_cp_cached) {
        HW_WR(FFT, CTRL, cp);
        m_cp_cached = cp;
    }
    HW_WR(FFT, START, 1u);
}

bool FftDriver::busy() const
{
    return (HW_RD(FFT, STATUS) & 1u) == 0u;
}

void LdpcDecoder::run(Ctx &ctx)
{
    HW_WR(LDPC, CTRL, ctx.grant->tbs);
    HW_WR(LDPC, START, 1u);
    HW_POLL(LDPC, STATUS, 1u);
    m_iter = HW_RD(LDPC, STATUS) >> 8;
    ctx.soft = new uint8_t[ctx.grant->tbs];        // heap in ISR context (C++ new)
}

void CrcStage::run(Ctx &ctx)
{
    ctx.crc_ok = (ctx.grant->seed & 1u) ? 1u : 0u;
    shm::g_harq_ack.ack   = (uint8_t)ctx.crc_ok;   // written here, read by the UL core
    shm::g_harq_ack.valid = 1u;
    delete[] ctx.soft;
    IPC_SEND(CH_DL_TO_UL, &shm::g_harq_ack);
}

static void run_stage(Stage *st, Ctx &ctx)
{
    st->run(ctx);                                   // virtual dispatch
}

void pipeline_run()
{
    Ctx ctx = { &shm::g_grant[shm::g_timing.slot & 1u], nullptr, 0u };
    if (!ctx.grant->valid) {
        return;
    }
    for (Stage *st : s_stages) {
        run_stage(st, ctx);
    }
    shm::State::bump();                             // class-static member write
}

}  // namespace dl

ISR_ENTRY(dl_symbol_isr)
{
    dl::s_symbols++;
    shm::g_timing.symbol = (uint8_t)(dl::s_symbols % 14u);
    dl::FftDriver::instance().kick(shm::g_timing.symbol);
    if (dl::FftDriver::instance().busy()) {
        shm::State::agc_target_dbm -= 1;
    }
}

ISR_ENTRY(dl_pdsch_isr)
{
    dl::pipeline_run();
}
