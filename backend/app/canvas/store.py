"""画布状态存储（内存实现，预留数据库扩展点）"""
from __future__ import annotations

from abc import ABC, abstractmethod

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
    """内存存储，MVP 用"""

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
