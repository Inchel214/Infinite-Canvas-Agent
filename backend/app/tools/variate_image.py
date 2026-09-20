"""图生图工具：基于画布上的参考图生成变体"""
from __future__ import annotations

import uuid

from app.canvas.state import CanvasNode, CanvasState
from app.image.base import BaseImageGenerator
from app.tools.base import BaseTool, ToolResult
from app.tools.layout import next_position


class VariateImageTool(BaseTool):
    name = "variate_image"
    description = "图生图：基于画布上一张参考图，用新提示词生成变体图片"
    args_schema = {
        "type": "object",
        "properties": {
            "node_id": {"type": "string", "description": "参考图节点 ID"},
            "prompt": {"type": "string", "description": "变体描述提示词"},
            "x": {"type": "number", "description": "新图放置位置 x"},
            "y": {"type": "number", "description": "新图放置位置 y"},
            "size": {
                "type": "string",
                "description": "生成尺寸：'1K'/'2K'/'4K'，或 '宽x高' 具体像素（如 2048x1152）",
            },
        },
        "required": ["node_id", "prompt"],
    }

    def __init__(self, image_generator: BaseImageGenerator):
        self.image_generator = image_generator

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        node_id = kwargs.get("node_id", "")
        prompt = kwargs.get("prompt", "")
        size = str(kwargs.get("size", "2K"))
        x = float(kwargs.get("x", 100))
        y = float(kwargs.get("y", 100))

        source = state.get_node(node_id)
        if not source:
            return ToolResult(
                success=False,
                message=f"参考图节点不存在: {node_id}",
                state=state,
            )
        if not source.image_url:
            return ToolResult(
                success=False,
                message=f"节点 {node_id} 不是图片节点",
                state=state,
            )

        # 自动布局（默认位置时）
        if x == 100 and y == 100:
            x, y = next_position(state, source.width, source.height)

        result = self.image_generator.variate(
            source_image_url=source.image_url,
            prompt=prompt,
            width=source.width,
            height=source.height,
            size=size,
        )

        node = CanvasNode(
            id=str(uuid.uuid4()),
            type="image",
            x=x,
            y=y,
            width=result.width,
            height=result.height,
            content=prompt,
            image_url=result.image_url,
            source_ids=[node_id],
        )
        state.add_node(node)
        return ToolResult(
            success=True,
            message=f"已基于参考图生成变体: {prompt}",
            state=state,
            data={"node_id": node.id, "image_url": result.image_url},
        )
