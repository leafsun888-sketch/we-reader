#!/usr/bin/env python3
"""Agent-based, read-only preview of the proposed Twitter value filter."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from sync import PROJECT, classify_value_with_terra


DEFAULT_DATA = PROJECT / "data"


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def classify(items: list[dict[str, Any]]) -> dict[str, Any]:
    decisions = classify_value_with_terra(items)
    return {"decisions": list(decisions.values())}


def account_items(data_root: Path, account: str, limit: int) -> list[dict[str, Any]]:
    library = read_json(data_root / "数据" / "library.json", {"sources": []})
    needle = account.strip().lstrip("@").casefold()
    source = next((entry for entry in library.get("sources", []) if entry.get("platform") == "twitter" and (
        str(entry.get("screenName") or "").casefold() == needle
        or str(entry.get("name") or "").casefold() == needle
    )), None)
    if not source:
        raise RuntimeError(f"本地书库找不到 Twitter 账号：{account}")
    items = sorted(source.get("items", []), key=lambda item: (int(item.get("t") or 0), str(item.get("rid") or "")), reverse=True)
    return [{**item, "source": source.get("name")} for item in items[:limit]]


def main() -> None:
    parser = argparse.ArgumentParser(description="Preview the proposed agent-based Twitter value filter")
    parser.add_argument("--account", required=True, help="Local Twitter screen name, for example karpathy")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--data-root", default=str(DEFAULT_DATA))
    args = parser.parse_args()
    items = account_items(Path(args.data_root).expanduser().resolve(), args.account, max(1, min(args.limit, 60)))
    print(json.dumps(classify(items), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
