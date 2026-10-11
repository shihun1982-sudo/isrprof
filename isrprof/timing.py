"""Time unit handling for 3GPP NR numerology.

Everything inside the tool is kept in microseconds.  Config files may use
human units: "1.2 symbol", "0.5 slot", "-30 us", "2 ms", "1 subframe".
Symbol length defaults to slot/14 (normal CP, equal-length approximation);
it can be overridden with ``numerology.symbol_us`` when exact CP handling is needed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_UNIT_RE = re.compile(
    r"^\s*([+-]?\d+(?:\.\d+)?)\s*"
    r"(symbols?|syms?|slots?|subframes?|sf|frames?|us|usec|ms|msec|ns)?\s*$",
    re.IGNORECASE,
)


@dataclass
class Numerology:
    mu: int = 1
    symbols_per_slot: int = 14
    symbol_us: float | None = None

    @property
    def slot_us(self) -> float:
        return 1000.0 / (2 ** self.mu)

    @property
    def sym_us(self) -> float:
        return self.symbol_us if self.symbol_us else self.slot_us / self.symbols_per_slot

    def parse(self, expr, default_unit: str = "symbol") -> float:
        """Parse a time expression into microseconds."""
        if expr is None:
            return 0.0
        if isinstance(expr, (int, float)):
            return self._scale(float(expr), default_unit)
        m = _UNIT_RE.match(str(expr))
        if not m:
            raise ValueError(f"Cannot parse time expression: {expr!r}")
        value = float(m.group(1))
        unit = (m.group(2) or default_unit).lower()
        return self._scale(value, unit)

    def _scale(self, value: float, unit: str) -> float:
        unit = unit.lower()
        if unit.startswith("sym"):
            return value * self.sym_us
        if unit.startswith("slot"):
            return value * self.slot_us
        if unit in ("subframe", "subframes", "sf"):
            return value * 1000.0
        if unit.startswith("frame"):
            return value * 10000.0
        if unit in ("us", "usec"):
            return value
        if unit in ("ms", "msec"):
            return value * 1000.0
        if unit == "ns":
            return value / 1000.0
        raise ValueError(f"Unknown time unit {unit!r}")

    def fmt(self, us: float) -> str:
        """Human readable: '1.20 sym (42.9 us)'."""
        return f"{us / self.sym_us:.2f} sym ({us:.1f} us)"

    def to_dict(self) -> dict:
        return {
            "mu": self.mu,
            "symbols_per_slot": self.symbols_per_slot,
            "slot_us": self.slot_us,
            "symbol_us": self.sym_us,
        }
