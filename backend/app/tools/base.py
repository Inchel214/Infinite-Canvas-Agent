"""工具基类与工具管理器（预留扩展点）"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.canvas.state import CanvasState


@dataclass
class ToolResult:
    """工具执行结果"""
    success: bool
    message: str
    state: CanvasState | None = None
    data: dict | None = None


class BaseTool(ABC):
    """工具基类，所有工具继承此接口"""

    name: str
    description: str
    args_schema: dict

    @abstractmethod
    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        """执行工具，返回结果"""
        ...


class ToolManager:
    """工具注册表，支持动态注册/查询"""

    def __init__(self):
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> BaseTool:
        if name not in self._tools:
            raise ValueError(f"工具不存在: {name}")
        return self._tools[name]

    def list_tools(self) -> list[BaseTool]:
        return list(self._tools.values())

    def list_schemas(self) -> list[dict]:
        """返回给 LLM 的工具描述列表"""
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "args_schema": tool.args_schema,
            }
            for tool in self._tools.values()
        ]
