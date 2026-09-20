"""局部编辑工具：对画布上的图片进行 inpainting / outpainting"""
from __future__ import annotations

import uuid

from app.canvas.state import CanvasNode, CanvasState
from app.image.base import BaseImageGenerator
from app.tools.base import BaseTool, ToolResult
from app.tools.layout import next_position


class EditImageTool(BaseTool):
    name = "edit_image"
    description = "局部编辑：对画布上的图片进行重绘 / 局部修改 / 扩展"
    args_schema = {
        "type": "object",
        "properties": {
            "node_id": {"type": "string", "description": "要编辑的图片节点 ID"},
            "prompt": {"type": "string", "description": "编辑描述提示词"},
            "mask": {"type": "string", "description": "蒙版描述（可选，如 左上角、背景 等）"},
            "x": {"type": "number", "description": "新图放置位置 x（默认在原图右侧）"},
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
        mask = kwargs.get("mask")
        size = str(kwargs.get("size", "2K"))

        source = state.get_node(node_id)
        if not source:
            return ToolResult(
                success=False,
                message=f"图片节点不存在: {node_id}",
                state=state,
            )
        if not source.image_url:
            return ToolResult(
                success=False,
                message=f"节点 {node_id} 不是图片节点",
                state=state,
            )

        # 位置：用户指定则用用户值，否则自动布局
        x = float(kwargs.get("x", 100))
        y = float(kwargs.get("y", 100))
        if x == 100 and y == 100:
            x, y = next_position(state, source.width, source.height)

        result = self.image_generator.edit(
            source_image_url=source.image_url,
            prompt=prompt,
            mask=mask,
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
            message=f"已编辑图片: {prompt}",
            state=state,
            data={"node_id": node.id, "image_url": result.image_url},
        )
