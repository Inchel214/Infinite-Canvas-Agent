"""图片配方与用户行为反馈，按画布 JSONL 持久化。"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path


def make_recipe(prompt: str = "", style: str = "", size: str = "2K", model: str = "") -> dict:
    words = re.findall(r"[A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,8}", prompt or "")
    return {"keywords": list(dict.fromkeys(words))[:16], "style": style, "size": size or "2K", "model": model}


class FeedbackStore:
    def __init__(self, directory: str | Path | None = None):
        self.directory = Path(directory or os.getenv("FEEDBACK_DATA_DIR") or Path(__file__).resolve().parent.parent / "data" / "feedback")
        self._lock = threading.RLock()

    def _path(self, canvas_id: str) -> Path:
        # ID 只作为本地文件名，阻止路径穿越。
        return self.directory / f"{re.sub(r'[^A-Za-z0-9_-]', '_', canvas_id)}.jsonl"

    def list(self, canvas_id: str) -> list[dict]:
        try:
            return [json.loads(line) for line in self._path(canvas_id).read_text(encoding="utf-8").splitlines() if line.strip()]
        except (FileNotFoundError, OSError):
            return []

    def _append(self, canvas_id: str, record: dict) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        with self._path(canvas_id).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def record(self, canvas_id: str, node: dict | None = None, outcome: str = "kept", round_id: str = "", recipe: dict | None = None) -> dict:
        if outcome not in {"kept", "deleted", "retried", "edited", "cloned"}:
            raise ValueError("未知反馈类型")
        with self._lock:
            record = {
                "recipe": recipe or (node or {}).get("recipe") or make_recipe((node or {}).get("content", "")),
                "prompt": (node or {}).get("content", ""),
                "outcome": outcome,
                "ts": time.time(),
                "round_id": round_id,
                "node_id": (node or {}).get("id", ""),
                "voided": False,
            }
            self._append(canvas_id, record)
            return record

    def void_round(self, canvas_id: str, round_id: str) -> None:
        if not round_id:
            return
        with self._lock:
            self._append(canvas_id, {"round_id": round_id, "voided": True, "ts": time.time(), "event": "undo"})

    def query(self, canvas_id: str, keywords: list[str] | None = None, style: str = "") -> list[dict]:
        voided = {r.get("round_id") for r in self.list(canvas_id) if r.get("event") == "undo" and r.get("round_id")}
        candidates = [r for r in self.list(canvas_id) if not r.get("event") and r.get("round_id") not in voided and not r.get("voided")]
        def matches(row: dict) -> bool:
            recipe = row.get("recipe", {})
            if style and style != recipe.get("style"):
                return False
            haystack = (row.get("prompt", "") + " " + " ".join(recipe.get("keywords", []))).lower()
            return not keywords or any(str(k).lower() in haystack for k in keywords)
        return [r for r in candidates if matches(r)][-5:][::-1]


feedback_store = FeedbackStore()
