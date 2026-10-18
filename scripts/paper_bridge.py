#!/usr/bin/env python
"""资料馆 ⇄ paper_import.py 的桥接层。

调用方式（Node 侧 spawn）：
    python paper_bridge.py '<json>'
    JSON: {"action": "search", "query": "...", "source": "auto", "limit": 8, "mode": "keyword"}

输出：一行 JSON 到 stdout（UTF-8）。失败时 {"ok": false, "error": "..."}。

为什么要这层：paper_import.py 是上游项目里现成的十源检索实现（arXiv / OpenAlex /
Crossref / DOAJ / INSPIRE / Europe PMC / Zenodo / HAL / DataCite / OpenAIRE …），
只用标准库，所以资料馆直接 spawn 它，不重写一遍。
"""
from __future__ import annotations

import json
import sys
import os
from pathlib import Path

# 让 import tools.paper_import 能找到
DEFAULT_SERVER_DIR = ""


def main() -> None:
    raw = sys.argv[1] if len(sys.argv) > 1 else "{}"
    try:
        req = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"bad json: {exc}"}, ensure_ascii=False))
        return

    server_dir = req.get("serverDir") or os.environ.get("WYM_SERVER_DIR") or DEFAULT_SERVER_DIR
    if not server_dir:
        print(json.dumps({"ok": False, "error": "未配置 paperServerDir：请在插件 config.json 里指向提供 paper_import.py 的 server 目录"}, ensure_ascii=False))
        return
    sys.path.insert(0, server_dir)

    try:
        from tools.paper_import import search_papers  # type: ignore
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"import paper_import failed: {exc}"}, ensure_ascii=False))
        return

    action = req.get("action") or "search"
    try:
        if action == "search":
            query = str(req.get("query") or "").strip()
            if not query:
                print(json.dumps({"ok": False, "error": "empty query"}, ensure_ascii=False))
                return
            limit = max(1, min(50, int(req.get("limit") or 8)))
            source = str(req.get("source") or "auto")
            mode = str(req.get("mode") or "keyword")
            items = search_papers(query, max_results=limit, source=source, mode=mode)
            print(json.dumps({"ok": True, "count": len(items), "items": items}, ensure_ascii=False))
            return
        print(json.dumps({"ok": False, "error": f"unknown action: {action}"}, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
