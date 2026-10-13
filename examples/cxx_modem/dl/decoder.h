// C++ modem sample - DL decoder class hierarchy: a virtual pipeline stage interface, two decoders,
// a driver object with methods, and a function-pointer table of stages.
#pragma once
#include <stdint.h>
#include "../common/shared.h"

namespace dl {

struct Ctx { const shm::Grant *grant; uint8_t *soft; uint32_t crc_ok; };

class Stage {
public:
    virtual ~Stage() {}
    virtual void run(Ctx &ctx) = 0;          // virtual call: the profiler attaches every override as a candidate
    const char *name() const { return m_name; }
protected:
    explicit Stage(const char *n) : m_name(n) {}
    const char *m_name;
};

class LdpcDecoder : public Stage {
public:
    LdpcDecoder() : Stage("ldpc"), m_iter(0) {}
    void run(Ctx &ctx) override;
    uint32_t iterations() const { return m_iter; }
private:
    uint32_t m_iter;
};

class CrcStage : public Stage {
public:
    CrcStage() : Stage("crc") {}
    void run(Ctx &ctx) override;
};

class FftDriver {
public:
    void kick(uint8_t sym);
    bool busy() const;
    static FftDriver &instance();
private:
    uint16_t m_cp_cached = 0;
};

void pipeline_run();

}  // namespace dl
