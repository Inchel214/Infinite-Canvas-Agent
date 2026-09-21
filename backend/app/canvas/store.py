"""画布状态存储（内存 + 文件持久化，预留数据库扩展点）"""
from __future__ import annotations

import copy
import json
import os
from abc import ABC, abstractmethod
from pathlib import Path

from app.canvas.state import CanvasState, create_canvas

# 历史栈最大长度（避免无限制增长占用内存）
_MAX_HISTORY = 50


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

    @abstractmethod
    def undo(self, canvas_id: str) -> CanvasState | None:
        """撤销最近一次 save_canvas，恢复到上一份快照。无历史可撤销时返回 None。"""
        ...


class InMemoryStore(BaseStore):
    """内存存储（带 undo 历史栈）"""

    def __init__(self):
        self._canvases: dict[str, CanvasState] = {}
        # 每个 canvas_id 对应一份快照栈，按时间顺序，最后入栈的是最近一次保存前的状态
        self._history: dict[str, list[CanvasState]] = {}

    def create_canvas(self) -> CanvasState:
        state = create_canvas()
        self._canvases[state.canvas_id] = state
        self._history[state.canvas_id] = []
        return state

    def get_canvas(self, canvas_id: str) -> CanvasState:
        if canvas_id not in self._canvases:
            raise ValueError(f"画布不存在: {canvas_id}")
        # 返回深拷贝：调用方修改不影响内存中的"旧状态"，保证 undo 历史正确
        return copy.deepcopy(self._canvases[canvas_id])

    def save_canvas(self, state: CanvasState) -> None:
        cid = state.canvas_id
        # 入栈：保存"当前内存中的旧状态"的深拷贝，作为可撤销点
        if cid in self._canvases:
            hist = self._history.setdefault(cid, [])
            hist.append(copy.deepcopy(self._canvases[cid]))
            if len(hist) > _MAX_HISTORY:
                hist.pop(0)
        self._canvases[cid] = state

    def undo(self, canvas_id: str) -> CanvasState | None:
        hist = self._history.get(canvas_id) or []
        if not hist:
            return None
        prev = hist.pop()
        # 恢复到内存（不重新入栈，否则无法重做/反复撤销）
        self._canvases[canvas_id] = prev
        return prev


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
        # 不走 save_canvas（避免创建动作本身被入栈为可撤销点）
        state = create_canvas()
        self._canvases[state.canvas_id] = state
        self._history[state.canvas_id] = []
        # 写入磁盘
        path = self._canvas_path(state.canvas_id)
        try:
            with path.open("w", encoding="utf-8") as f:
                json.dump(state.to_dict(), f, ensure_ascii=False)
        except OSError:
            pass
        return state

    def get_canvas(self, canvas_id: str) -> CanvasState:
        # 优先内存，其次磁盘（懒加载，支持后端重启后恢复）
        if canvas_id in self._canvases:
            # 返回深拷贝：调用方修改不影响内存中的"旧状态"，保证 undo 历史正确
            return copy.deepcopy(self._canvases[canvas_id])
        state = self._load_from_disk(canvas_id)
        if state is None:
            raise ValueError(f"画布不存在: {canvas_id}")
        self._canvases[canvas_id] = state
        return copy.deepcopy(state)

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

    def undo(self, canvas_id: str) -> CanvasState | None:
        prev = super().undo(canvas_id)
        if prev is not None:
            # 同步写回磁盘，保持内存/磁盘一致
            path = self._canvas_path(canvas_id)
            try:
                with path.open("w", encoding="utf-8") as f:
                    json.dump(prev.to_dict(), f, ensure_ascii=False)
            except OSError:
                pass
        return prev
