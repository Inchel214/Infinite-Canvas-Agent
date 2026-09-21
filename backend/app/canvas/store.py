"""画布状态存储（内存 + 文件持久化，预留数据库扩展点）"""
from __future__ import annotations

import json
import os
from abc import ABC, abstractmethod
from pathlib import Path

from app.canvas.state import CanvasState, create_canvas


class BaseStore(ABC):
    """存储抽象接口，后续可替换为 Postgres/Redis"""

    @abstractmethod
    def get_canvas(self, canvas_id: str) -> CanvasState:
        ...

    @abstractmethod
    def save_canvas(self, state: CanvasState) -> None:
        ...

    @abstractmethod
    def create_canvas(self) -> CanvasState:
        ...


class InMemoryStore(BaseStore):
    """内存存储"""

    def __init__(self):
        self._canvases: dict[str, CanvasState] = {}

    def create_canvas(self) -> CanvasState:
        state = create_canvas()
        self._canvases[state.canvas_id] = state
        return state

    def get_canvas(self, canvas_id: str) -> CanvasState:
        if canvas_id not in self._canvases:
            raise ValueError(f"画布不存在: {canvas_id}")
        return self._canvases[canvas_id]

    def save_canvas(self, state: CanvasState) -> None:
        self._canvases[state.canvas_id] = state


class FileStore(InMemoryStore):
    """内存 + 文件持久化存储，后端重启后仍可恢复画布状态"""

    def __init__(self, data_dir: str | None = None):
        super().__init__()
        if data_dir is None:
            data_dir = os.getenv("CANVAS_DATA_DIR")
        if data_dir is None:
            # 默认放在 backend/data/canvases
            data_dir = str(Path(__file__).resolve().parent.parent.parent / "data" / "canvases")
        self._data_dir = Path(data_dir)
        self._data_dir.mkdir(parents=True, exist_ok=True)

    def _canvas_path(self, canvas_id: str) -> Path:
        # 用 canvas_id 作为文件名（uuid，安全）
        return self._data_dir / f"{canvas_id}.json"

    def _load_from_disk(self, canvas_id: str) -> CanvasState | None:
        path = self._canvas_path(canvas_id)
        if not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            return CanvasState.from_dict(data)
        except (json.JSONDecodeError, KeyError, OSError):
            return None

    def create_canvas(self) -> CanvasState:
        state = super().create_canvas()
        self.save_canvas(state)
        return state

    def get_canvas(self, canvas_id: str) -> CanvasState:
        # 优先内存，其次磁盘（懒加载，支持后端重启后恢复）
        if canvas_id in self._canvases:
            return self._canvases[canvas_id]
        state = self._load_from_disk(canvas_id)
        if state is None:
            raise ValueError(f"画布不存在: {canvas_id}")
        self._canvases[canvas_id] = state
        return state

    def save_canvas(self, state: CanvasState) -> None:
        super().save_canvas(state)
        # 写入磁盘，确保刷新/重启后可恢复
        path = self._canvas_path(state.canvas_id)
        try:
            with path.open("w", encoding="utf-8") as f:
                json.dump(state.to_dict(), f, ensure_ascii=False)
        except OSError:
            # 磁盘写入失败不影响内存中的状态
            pass
