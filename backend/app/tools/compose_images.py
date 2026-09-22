"""多图组合工具：将画布上的多张图片合成为一张"""
from __future__ import annotations

import uuid

from app.canvas.state import CanvasNode, CanvasState
from app.image.base import BaseImageGenerator
from app.tools.base import BaseTool, ToolResult
from app.tools.layout import next_position


class ComposeImagesTool(BaseTool):
    name = "compose_images"
    description = "多图组合：将画布上选中的多张图片拼接/合成为一张新图"
    args_schema = {
        "type": "object",
        "properties": {
            "node_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要组合的图片节点 ID 列表",
            },
            "prompt": {"type": "string", "description": "组合描述提示词（可选）"},
            "x": {"type": "number", "description": "新图放置位置 x"},
            "y": {"type": "number", "description": "新图放置位置 y"},
            "size": {
                "type": "string",
                "description": "生成尺寸：'1K'/'2K'/'4K'，或 '宽x高' 具体像素（如 2048x1152）",
            },
        },
        "required": ["node_ids"],
    }

    def __init__(self, image_generator: BaseImageGenerator):
        self.image_generator = image_generator

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        node_ids: list[str] = kwargs.get("node_ids", [])
        prompt = kwargs.get("prompt", "")
        size = str(kwargs.get("size", "2K"))

        sources = [state.get_node(nid) for nid in node_ids]
        sources = [n for n in sources if n is not None and n.image_url]

        if len(sources) < 2:
            return ToolResult(
                success=False,
                message="至少需要 2 张图片才能组合",
                state=state,
            )

        # 位置：用户指定则用用户值，否则自动布局
        width = max(n.width for n in sources)
        height = max(n.height for n in sources)
        x = float(kwargs.get("x", 100))
        y = float(kwargs.get("y", 100))
        if x == 100 and y == 100:
            x, y = next_position(state, width, height)

        urls = [n.image_url for n in sources]

        # 仅把参考图发给模型，提示词由用户自己描述，不自动拼接源图 content
        result = self.image_generator.compose(
            image_urls=urls,
            prompt=prompt,
            width=width,
            height=height,
            size=size,
        )

        node = CanvasNode(
            id=str(uuid.uuid4()),
            type="image",
            x=x,
            y=y,
            width=result.width,
            height=result.height,
            content=prompt or f"{len(sources)} 图组合",
            image_url=result.image_url,
            source_ids=list(node_ids),
        )
        state.add_node(node)
        return ToolResult(
            success=True,
            message=f"已组合 {len(sources)} 张图片",
            state=state,
            data={"node_id": node.id, "image_url": result.image_url},
        )
