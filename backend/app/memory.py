"""跨画布用户偏好：小规模、可编辑、可持久化。"""
from __future__ import annotations

import copy
import difflib
import json
import os
import threading
import time
import uuid
from pathlib import Path


class MemoryStore:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.getenv("MEMORY_DATA_FILE") or Path(__file__).resolve().parent.parent / "data" / "preferences.json")
        self._lock = threading.RLock()
        self._items: list[dict] | None = None

    def _load(self) -> list[dict]:
        if self._items is None:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self._items = data.get("items", []) if isinstance(data, dict) else []
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                self._items = []
        return self._items

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"items": self._items or []}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def list(self) -> list[dict]:
        with self._lock:
            return copy.deepcopy(self._load())

    def save(self, text: str, source_round: str = "", preference_id: str = "") -> dict:
        text = " ".join(text.split())[:200]
        if not text:
            raise ValueError("偏好内容不能为空")
        with self._lock:
            items = self._load()
            match = next((x for x in items if x["id"] == preference_id), None)
            if match is None:
                # 精确/高相似偏好合并，避免同义反复占用目录。
                match = next((x for x in items if difflib.SequenceMatcher(None, x["text"].lower(), text.lower()).ratio() >= 0.72), None)
            if match:
                match.update(text=text, hits=int(match.get("hits", 0)) + 1, last_hit=time.time(), source_round=source_round)
                item = match
            else:
                item = {"id": uuid.uuid4().hex[:12], "text": text, "hits": 1, "last_hit": time.time(), "source_round": source_round}
                items.append(item)
            if len(items) > 20:
                items.sort(key=lambda x: (x.get("hits", 0), x.get("last_hit", 0)), reverse=True)
                del items[20:]
            self._save()
            return copy.deepcopy(item)

    def update(self, preference_id: str, text: str) -> dict | None:
        text = " ".join(text.split())[:200]
        if not text:
            raise ValueError("偏好内容不能为空")
        with self._lock:
            item = next((x for x in self._load() if x["id"] == preference_id), None)
            if item is None:
                return None
            item["text"] = text
            self._save()
            return copy.deepcopy(item)

    def delete(self, preference_id: str) -> bool:
        with self._lock:
            items = self._load()
            remaining = [x for x in items if x["id"] != preference_id]
            if len(remaining) == len(items):
                return False
            self._items = remaining
            self._save()
            return True

    def catalog(self) -> str:
        items = sorted(self.list(), key=lambda x: (x.get("hits", 0), x.get("last_hit", 0)), reverse=True)[:5]
        text = "\n".join(f"- {x['id']}：{x['text']}" for x in items)
        return text[:300]


memory_store = MemoryStore()
