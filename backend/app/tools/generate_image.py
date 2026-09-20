"""文生图工具：根据提示词生成图片并放到画布上"""
from __future__ import annotations

import uuid

from app.canvas.state import CanvasNode, CanvasState
from app.image.base import BaseImageGenerator
from app.tools.base import BaseTool, ToolResult
from app.tools.layout import next_position


class GenerateImageTool(BaseTool):
    name = "generate_image"
    description = "文生图：根据文字提示生成一张图片并放到画布上"
    args_schema = {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "图片描述提示词"},
            "x": {"type": "number", "description": "放置位置 x 坐标"},
            "y": {"type": "number", "description": "放置位置 y 坐标"},
            "width": {"type": "number", "description": "图片宽度"},
            "height": {"type": "number", "description": "图片高度"},
            "size": {
                "type": "string",
                "description": "生成尺寸：'1K'/'2K'/'4K' 分辨率档位，或 '宽x高' 具体像素（如 2048x1152 宽幅、1152x2048 竖幅）",
            },
        },
        "required": ["prompt"],
    }

    def __init__(self, image_generator: BaseImageGenerator):
        self.image_generator = image_generator

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        prompt = kwargs.get("prompt", "")
        width = int(kwargs.get("width", 300))
        height = int(kwargs.get("height", 300))
        size = str(kwargs.get("size", "2K"))
        # 若未显式指定位置（使用默认值），则自动布局避免重叠
        x = float(kwargs.get("x", 100))
        y = float(kwargs.get("y", 100))
        if x == 100 and y == 100:
            x, y = next_position(state, width, height)

        result = self.image_generator.generate(prompt, width=width, height=height, size=size)

        node = CanvasNode(
            id=str(uuid.uuid4()),
            type="image",
            x=x,
            y=y,
            width=result.width,
            height=result.height,
            content=prompt,
            image_url=result.image_url,
        )
        state.add_node(node)
        return ToolResult(
            success=True,
            message=f"已生成图片: {prompt}",
            state=state,
            data={"node_id": node.id, "image_url": result.image_url},
        )
