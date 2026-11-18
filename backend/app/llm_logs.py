"""每次 LLM 请求的完整上下文日志：固定份数、按大小滚动覆盖。"""
from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)


class RollingContextLog:
    """JSONL 滚动日志；单条记录即使超限也完整写入，不截断上下文。"""

    def __init__(self, directory: str | Path, files: int = 5, max_bytes: int = 10 * 1024 * 1024):
        self.directory = Path(directory)
        self.files = max(1, files)
        self.max_bytes = max(1, max_bytes)
        self._lock = threading.Lock()
        self._index = 0

    def write(self, body: dict, *, stream: bool) -> None:
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "model": body.get("model"),
            "stream": stream,
            "messages": copy.deepcopy(body.get("messages", [])),
            "tools": copy.deepcopy(body.get("tools", [])),
            "request": {
                key: copy.deepcopy(value)
                for key, value in body.items()
                if key not in ("messages", "tools") and "key" not in key.lower()
            },
        }
        line = (json.dumps(record, ensure_ascii=False, default=str) + "\n").encode("utf-8")
        self.directory.mkdir(parents=True, exist_ok=True)
        with self._lock:
            path = self.directory / f"context_{self._index + 1}.jsonl"
            size = path.stat().st_size if path.exists() else 0
            if size and size + len(line) > self.max_bytes:
                self._index = (self._index + 1) % self.files
                path = self.directory / f"context_{self._index + 1}.jsonl"
                # 覆盖旧份，保证总份数不增长。
                path.write_bytes(line)
            else:
                with path.open("ab") as f:
                    f.write(line)


_default: RollingContextLog | None = None
_default_lock = threading.Lock()


def log_llm_request(body: dict, *, stream: bool) -> None:
    """日志故障不得影响真实模型请求；只记录请求体，不接触 API Key。"""
    try:
        global _default
        with _default_lock:
            directory = os.getenv("LLM_CONTEXT_LOG_DIR") or str(
                Path(__file__).resolve().parent.parent / "data" / "llm_logs"
            )
            files = int(os.getenv("LLM_CONTEXT_LOG_FILES", "5"))
            max_bytes = int(os.getenv("LLM_CONTEXT_LOG_MAX_BYTES", str(10 * 1024 * 1024)))
            if (
                _default is None
                or _default.directory != Path(directory)
                or _default.files != files
                or _default.max_bytes != max_bytes
            ):
                _default = RollingContextLog(directory, files, max_bytes)
        _default.write(body, stream=stream)
    except Exception:
        logger.warning("LLM 完整上下文日志写入失败（已忽略）", exc_info=True)
