"""删除节点工具"""
from __future__ import annotations

from app.canvas.state import CanvasState
from app.tools.base import BaseTool, ToolResult


class DeleteNodeTool(BaseTool):
    name = "delete_node"
    description = "删除画布上指定的节点"
    args_schema = {
        "type": "object",
        "properties": {
            "node_id": {"type": "string", "description": "节点 ID"},
        },
        "required": ["node_id"],
    }

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        node_id = kwargs.get("node_id", "")

        node = state.get_node(node_id)
        if not node:
            return ToolResult(
                success=False,
                message=f"节点不存在: {node_id}",
                state=state,
            )

        state.remove_node(node_id)
        return ToolResult(
            success=True,
            message=f"已删除节点: {node_id}",
            state=state,
        )
