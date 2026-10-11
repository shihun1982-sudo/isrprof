"""isrprof - interrupt-driven modem firmware profiler / visualizer.

Pipeline:
    config.load()      -> normalized config (timing units resolved to microseconds)
    cparser.parse()    -> functions, calls, HW macro accesses, global/static/heap accesses, IPC
    callgraph.build()  -> per-ISR call trees with start/length placed on the timing axes
    structure.analyze()-> Structure101-style DSM / levelization / tangles / layer-rule violations
    llm.LLMAssist      -> optional, config-driven helpers (cost estimation, macro classification)
    render.render()    -> single-file HTML viewer (3D timing graph + SW structure + HW blocks + DSM)
"""

__version__ = "0.1.0"
