// C++ modem sample - UL core: a templated ring buffer, a namespace of free functions and the UL ISRs.
#include "../hal/hal.h"
#include "../common/shared.h"

namespace ul {

template <typename T, unsigned N>
class Ring {
public:
    bool push(const T &v) { if (m_n == N) { return false; } m_buf[(m_head + m_n++) % N] = v; return true; }
    bool pop(T &v) { if (m_n == 0u) { return false; } v = m_buf[m_head]; m_head = (m_head + 1u) % N; m_n--; return true; }
private:
    T m_buf[N]; unsigned m_head = 0; unsigned m_n = 0;
};

static Ring<shm::HarqAck, 4> s_acks;
static int32_t s_last_ta;

namespace fe {
void apply_ta()
{
    int32_t ta = shm::g_timing.ta_tc;              // written by the scheduler core
    if (ta != s_last_ta) {
        HW_WR(RFIC, TA, (uint32_t)ta);
        s_last_ta = ta;
    }
}
void ifft_kick(uint8_t sym)
{
    HW_WR(IFFT, CTRL, sym);
    HW_WR(IFFT, START, 1u);
}
}  // namespace fe

static void collect_ack()
{
    shm::HarqAck a;
    if (IPC_RECV(CH_DL_TO_UL, &a) > 0 && shm::g_harq_ack.valid) {
        s_acks.push(shm::g_harq_ack);               // template method call
        shm::g_harq_ack.valid = 0u;
    }
}

}  // namespace ul

ISR_ENTRY(ul_symbol_isr)
{
    ul::fe::apply_ta();
    ul::fe::ifft_kick(shm::g_timing.symbol);
}

ISR_ENTRY(ul_pucch_isr)
{
    ul::collect_ack();
    shm::HarqAck a;
    if (ul::s_acks.pop(a)) {
        HW_WR(DMA, SRC, (uint32_t)a.harq_id);
        HW_WR(DMA, CTRL, 1u);
    }
}
