"""Emit the single-file HTML viewer with the profile JSON embedded.

The viewer source lives in ``templates/parts``: ``*.html`` parts (title/CSS, markup, data slot) are
concatenated in name order, followed by the ``*.js`` parts wrapped in one IIFE.  ``templates/vendor``
holds three.js, which is inlined so the output works offline.  Keeping the JS in small files makes the
viewer easy to extend without touching one giant template.
"""
from __future__ import annotations

import json
import os

PARTS_DIR = os.path.join(os.path.dirname(__file__), "templates", "parts")
VENDOR_DIR = os.path.join(os.path.dirname(__file__), "templates", "vendor")

STANDALONE_HEAD = (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
    "<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui,sans-serif}"
    "img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n"
)
STANDALONE_TAIL = "\n</body>\n</html>\n"

_TEMPLATE_CACHE: dict[str, str] = {}


def assemble_template() -> str:
    if "tpl" in _TEMPLATE_CACHE:
        return _TEMPLATE_CACHE["tpl"]
    html, js = [], []
    for name in sorted(os.listdir(PARTS_DIR)):
        with open(os.path.join(PARTS_DIR, name), "r", encoding="utf-8") as fh:
            txt = fh.read()
        (js if name.endswith(".js") else html).append(txt)
    vendor = []
    if os.path.isdir(VENDOR_DIR):
        for name in sorted(os.listdir(VENDOR_DIR)):
            if name.endswith(".js"):
                with open(os.path.join(VENDOR_DIR, name), "r", encoding="utf-8") as fh:
                    vendor.append(fh.read())
    tpl = "\n".join(html)
    tpl = tpl.replace("__VENDOR_JS__", "<script>\n" + "\n".join(vendor) + "\n</script>" if vendor else "")
    tpl += "\n<script>\n(function () {\n'use strict';\n" + "\n".join(js) + "\n})();\n</script>\n"
    _TEMPLATE_CACHE["tpl"] = tpl
    return tpl


def render_html(profile: dict, fragment: bool = False) -> str:
    tpl = assemble_template()
    data = json.dumps(profile, ensure_ascii=False, separators=(",", ":"))
    data = data.replace("</", "<\\/")          # never terminate the <script> block early
    html = tpl.replace("__PROFILE_JSON__", data)
    if fragment:
        return html
    return STANDALONE_HEAD + html + STANDALONE_TAIL


def write_outputs(profile: dict, html_path: str, json_path: str | None = None, fragment_path: str | None = None):
    os.makedirs(os.path.dirname(os.path.abspath(html_path)), exist_ok=True)
    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(render_html(profile))
    if json_path:
        os.makedirs(os.path.dirname(os.path.abspath(json_path)), exist_ok=True)
        with open(json_path, "w", encoding="utf-8") as fh:
            json.dump(profile, fh, indent=1, ensure_ascii=False)
    if fragment_path:
        with open(fragment_path, "w", encoding="utf-8") as fh:
            fh.write(render_html(profile, fragment=True))
