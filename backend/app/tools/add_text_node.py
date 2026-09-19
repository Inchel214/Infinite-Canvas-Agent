"""添加文本节点工具"""
from __future__ import annotations

import uuid

from app.canvas.state import CanvasNode, CanvasState
from app.tools.base import BaseTool, ToolResult


class AddTextNodeTool(BaseTool):
    name = "add_text_node"
    description = "在画布上添加一个文本节点"
    args_schema = {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "文本内容"},
            "x": {"type": "number", "description": "x 坐标"},
            "y": {"type": "number", "description": "y 坐标"},
        },
        "required": ["content"],
    }

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        content = kwargs.get("content", "")
        x = kwargs.get("x", 0.0)
        y = kwargs.get("y", 0.0)

        node = CanvasNode(
            id=str(uuid.uuid4()),
            type="text",
            x=float(x),
            y=float(y),
            width=200,
            height=60,
            content=content,
        )
        state.add_node(node)
        return ToolResult(
            success=True,
            message=f"已添加文本节点: {content}",
            state=state,
            data={"node_id": node.id},
        )
