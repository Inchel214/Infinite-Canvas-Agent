"""列出画布所有节点工具"""
from __future__ import annotations

from app.canvas.state import CanvasState
from app.tools.base import BaseTool, ToolResult


class ListNodesTool(BaseTool):
    name = "list_nodes"
    description = "列出画布上所有节点的信息"
    args_schema = {
        "type": "object",
        "properties": {},
    }

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        nodes = state.list_nodes()
        node_list = [
            {
                "id": n.id,
                "type": n.type,
                "content": n.content,
                "position": [n.x, n.y],
            }
            for n in nodes
        ]
        return ToolResult(
            success=True,
            message=f"画布上共有 {len(nodes)} 个节点",
            state=state,
            data={"nodes": node_list},
        )
