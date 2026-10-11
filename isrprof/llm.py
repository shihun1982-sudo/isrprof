"""Optional LLM assistance (config-driven, disabled by default).

Everything the model needs is in the ``llm:`` section of the config: provider,
model id, API-key environment variable, effort, cache file, and one entry per
task with ``enabled`` + ``prompt`` (the prompt can be overridden per project).

Tasks
-----
estimate_costs     For functions without a trace / config cost, ask the model for a
                   cycle estimate given the source and the core clock -> self cost (us).
classify_hw_macro  For ``#define`` macros that look like register accesses but are
                   not in the configured lists -> {kind, block_arg, reg_arg}.
summarize          One-line purpose summary per function (shown in the tooltip).
suggest_layers     Propose a layer assignment (ISR / scheduler / driver / HAL ...) for
                   functions that match no configured layer.

Only the ``anthropic`` provider is implemented (official SDK).  Results are cached
on disk keyed by (task, model, sha1(prompt)) so re-runs are free and
deterministic.  When the SDK or key is missing the assistant degrades to a no-op
and the pipeline continues with the static defaults.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any

DEFAULT_PROMPTS = {
    "estimate_costs": (
        "You are estimating worst-case execution time of embedded C functions running in an "
        "interrupt context on a {core_name} core at {clock_mhz} MHz (3GPP NR modem firmware). "
        "Only count the function's OWN instructions, not the callees (they are estimated "
        "separately). Register access macros cost ~{reg_cycles} cycles each (AXI/APB round trip).\n"
        "Return strict JSON: {{\"functions\": [{{\"id\": str, \"cycles\": int, \"reason\": str}}]}}.\n\n"
        "Functions:\n{functions_block}"
    ),
    "classify_hw_macro": (
        "These C preprocessor macros come from modem firmware. For each, decide whether it is a "
        "hardware register access and which argument identifies the HW block and the register.\n"
        "Return strict JSON: {{\"macros\": [{{\"name\": str, \"is_hw\": bool, \"kind\": "
        "\"read\"|\"write\"|\"rmw\"|null, \"block_arg\": int|null, \"reg_arg\": int|null}}]}}.\n\n{macros_block}"
    ),
    "summarize": (
        "Summarize each embedded C function in one short sentence (max 14 words) for a "
        "profiler tooltip. Return strict JSON: {{\"functions\": [{{\"id\": str, \"summary\": str}}]}}.\n\n"
        "{functions_block}"
    ),
    "suggest_layers": (
        "Assign each function to exactly one architectural layer from this ordered list "
        "(top to bottom): {layers}. Return strict JSON: {{\"functions\": [{{\"id\": str, "
        "\"layer\": str}}]}}.\n\n{functions_block}"
    ),
}


class LLMAssist:
    def __init__(self, cfg):
        self.cfg = cfg
        self.lcfg = cfg.llm
        self.enabled = bool(self.lcfg.get("enabled"))
        self.model = self.lcfg.get("model", "claude-opus-5-5")
        self.effort = self.lcfg.get("effort", "medium")
        self.max_tokens = int(self.lcfg.get("max_tokens", 4096))
        self.cache_path = os.path.join(cfg.base_dir, self.lcfg.get("cache_file", ".isrprof_llm_cache.json"))
        self.cache: dict[str, Any] = {}
        self.client = None
        self.log: list[str] = []
        if os.path.exists(self.cache_path):
            try:
                with open(self.cache_path, "r", encoding="utf-8") as fh:
                    self.cache = json.load(fh)
            except Exception:
                self.cache = {}
        if self.enabled:
            self._init_client()

    # ------------------------------------------------------------------ client
    def _init_client(self):
        provider = self.lcfg.get("provider", "anthropic")
        if provider != "anthropic":
            self.log.append(f"provider {provider!r} not implemented; LLM disabled")
            self.enabled = False
            return
        try:
            import anthropic  # official SDK
        except ImportError:
            self.log.append("anthropic SDK not installed (pip install anthropic); LLM disabled")
            self.enabled = False
            return
        key_env = self.lcfg.get("api_key_env", "ANTHROPIC_API_KEY")
        kwargs = {}
        if os.environ.get(key_env):
            kwargs["api_key"] = os.environ[key_env]
        if self.lcfg.get("base_url"):
            kwargs["base_url"] = self.lcfg["base_url"]
        try:
            self.client = anthropic.Anthropic(**kwargs)   # falls back to env / `ant auth login` profile
        except Exception as e:  # pragma: no cover
            self.log.append(f"anthropic client init failed: {e}; LLM disabled")
            self.enabled = False

    def task_enabled(self, task: str) -> bool:
        t = self.lcfg.get("tasks", {}).get(task, {})
        return self.enabled and bool(t.get("enabled", False))

    def prompt_for(self, task: str) -> str:
        t = self.lcfg.get("tasks", {}).get(task, {})
        return t.get("prompt") or DEFAULT_PROMPTS[task]

    # ------------------------------------------------------------------ call
    def ask_json(self, task: str, prompt: str) -> dict | None:
        key = hashlib.sha1(f"{task}|{self.model}|{prompt}".encode("utf-8")).hexdigest()
        if key in self.cache:
            return self.cache[key]
        if not self.enabled or self.client is None:
            return None
        system = self.lcfg.get("system_prompt") or (
            "You are a senior modem firmware engineer helping a static profiler. "
            "Answer with strict JSON only, no prose, no markdown fences."
        )
        try:
            # Default model is claude-opus-5-5; thinking is adaptive by default on this
            # model family, depth controlled by output_config.effort.
            resp = self.client.beta.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                system=system,
                output_config={"effort": self.effort},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",            # route safety refusals to a fallback model
                messages=[{"role": "user", "content": prompt}],
            )
        except Exception as e:
            self.log.append(f"{task}: API call failed: {e}")
            return None
        if getattr(resp, "stop_reason", None) == "refusal":
            self.log.append(f"{task}: request refused")
            return None
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        text = text.strip()
        if text.startswith("```"):
            text = text.strip("`")
            text = text[text.find("{"):]
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            self.log.append(f"{task}: non-JSON reply: {text[:120]!r}")
            return None
        self.cache[key] = data
        self._save_cache()
        return data

    def _save_cache(self):
        try:
            with open(self.cache_path, "w", encoding="utf-8") as fh:
                json.dump(self.cache, fh, indent=1)
        except OSError:
            pass

    # ------------------------------------------------------------------ tasks
    def estimate_costs(self, functions, core_name: str, clock_mhz: float) -> dict[str, float]:
        """Return {function id: self cost in us} for the given FunctionDefs."""
        if not self.task_enabled("estimate_costs") or not functions:
            return {}
        block = "\n\n".join(f"### id: {f.id}\n{f.signature}\n{{ {f.body_text[:1500]} }}" for f in functions)
        prompt = self.prompt_for("estimate_costs").format(
            core_name=core_name, clock_mhz=clock_mhz,
            reg_cycles=self.lcfg.get("tasks", {}).get("estimate_costs", {}).get("reg_access_cycles", 40),
            functions_block=block)
        data = self.ask_json("estimate_costs", prompt) or {}
        out = {}
        for item in data.get("functions", []):
            try:
                out[item["id"]] = float(item["cycles"]) / clock_mhz   # cycles / MHz = us
            except (KeyError, TypeError, ValueError):
                continue
        return out

    def classify_hw_macros(self, macros: dict[str, str]) -> dict[str, dict]:
        if not self.task_enabled("classify_hw_macro") or not macros:
            return {}
        block = "\n".join(f"{k}: {v}" for k, v in macros.items())
        data = self.ask_json("classify_hw_macro", self.prompt_for("classify_hw_macro").format(macros_block=block)) or {}
        return {m["name"]: m for m in data.get("macros", []) if m.get("is_hw")}

    def summarize(self, functions) -> dict[str, str]:
        if not self.task_enabled("summarize") or not functions:
            return {}
        block = "\n\n".join(f"### id: {f.id}\n{f.signature}\n{{ {f.body_text[:800]} }}" for f in functions)
        data = self.ask_json("summarize", self.prompt_for("summarize").format(functions_block=block)) or {}
        return {i["id"]: i["summary"] for i in data.get("functions", []) if "id" in i and "summary" in i}

    def suggest_layers(self, functions, layers: list[str]) -> dict[str, str]:
        if not self.task_enabled("suggest_layers") or not functions:
            return {}
        block = "\n\n".join(f"### id: {f.id}\n{f.signature}\n{{ {f.body_text[:500]} }}" for f in functions)
        data = self.ask_json("suggest_layers", self.prompt_for("suggest_layers").format(
            layers=" > ".join(layers), functions_block=block)) or {}
        return {i["id"]: i["layer"] for i in data.get("functions", []) if "id" in i and "layer" in i}
