"""移动节点工具"""
from __future__ import annotations

from app.canvas.state import CanvasState
from app.tools.base import BaseTool, ToolResult


class MoveNodeTool(BaseTool):
    name = "move_node"
    description = "移动画布上的节点到指定位置"
    args_schema = {
        "type": "object",
        "properties": {
            "node_id": {"type": "string", "description": "节点 ID"},
            "x": {"type": "number", "description": "目标 x 坐标"},
            "y": {"type": "number", "description": "目标 y 坐标"},
        },
        "required": ["node_id", "x", "y"],
    }

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        node_id = kwargs.get("node_id", "")
        x = kwargs.get("x", 0.0)
        y = kwargs.get("y", 0.0)

        node = state.get_node(node_id)
        if not node:
            return ToolResult(
                success=False,
                message=f"节点不存在: {node_id}",
                state=state,
            )

        node.x = float(x)
        node.y = float(y)
        state.version += 1
        return ToolResult(
            success=True,
            message=f"已移动节点到 ({x}, {y})",
            state=state,
        )
