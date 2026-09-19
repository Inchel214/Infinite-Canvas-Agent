"""画布状态数据模型"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Literal

NodeType = Literal["text", "image", "shape"]


@dataclass
class CanvasNode:
    """画布节点"""
    id: str
    type: NodeType
    x: float
    y: float
    width: float
    height: float
    content: str = ""
    # 图片节点的图片地址（URL 或 data URL）；非图片节点为空
    image_url: str = ""
    # 来源节点 ID 列表（用于多图组合连线）
    source_ids: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "content": self.content,
            "image_url": self.image_url,
            "source_ids": self.source_ids,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CanvasNode":
        return cls(
            id=data["id"],
            type=data["type"],
            x=data["x"],
            y=data["y"],
            width=data["width"],
            height=data["height"],
            content=data.get("content", ""),
            image_url=data.get("image_url", ""),
            source_ids=data.get("source_ids", []),
        )


@dataclass
class CanvasState:
    """画布状态"""
    canvas_id: str
    nodes: dict[str, CanvasNode] = field(default_factory=dict)
    version: int = 0

    def to_dict(self) -> dict:
        return {
            "canvas_id": self.canvas_id,
            "nodes": {nid: node.to_dict() for nid, node in self.nodes.items()},
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CanvasState":
        nodes = {
            nid: CanvasNode.from_dict(ndata)
            for nid, ndata in data.get("nodes", {}).items()
        }
        return cls(
            canvas_id=data["canvas_id"],
            nodes=nodes,
            version=data.get("version", 0),
        )

    def add_node(self, node: CanvasNode) -> None:
        self.nodes[node.id] = node
        self.version += 1

    def remove_node(self, node_id: str) -> None:
        if node_id in self.nodes:
            del self.nodes[node_id]
            self.version += 1

    def get_node(self, node_id: str) -> CanvasNode | None:
        return self.nodes.get(node_id)

    def update_node_position(self, node_id: str, x: float, y: float) -> None:
        if node_id in self.nodes:
            self.nodes[node_id].x = x
            self.nodes[node_id].y = y
            self.version += 1

    def list_nodes(self) -> list[CanvasNode]:
        return list(self.nodes.values())


def create_canvas() -> CanvasState:
    """创建新画布"""
    return CanvasState(canvas_id=str(uuid.uuid4()))
