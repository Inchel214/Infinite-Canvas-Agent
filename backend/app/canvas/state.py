"""画布状态数据模型"""
from __future__ import annotations

import threading
import time
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
    # 节点编号（画布内唯一、递增、删除不回收）：用户与 Agent 用 #N 指代图片
    index: int | None = None
    # 分组标签（用于分区布局，如"需求"、"设计"、"流程"）
    group: str = ""

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
            "index": self.index,
            "group": self.group,
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
            index=data.get("index"),
            group=data.get("group", ""),
        )


@dataclass
class CanvasState:
    """画布状态"""
    canvas_id: str
    nodes: dict[str, CanvasNode] = field(default_factory=dict)
    version: int = 0
    # 画布元数据（多画布管理用）；旧数据缺省时回退
    name: str = ""
    created_at: float = 0
    updated_at: float = 0
    # 下一个节点编号（add_node 自增分配；删除不回收，保证 #N 指代稳定）
    next_index: int = 1
    # 编号分配锁（不序列化）
    _index_lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def __post_init__(self):
        # 确保锁被初始化（从 dict 反序列化时不会自动调用 __post_init__）
        if not hasattr(self, '_index_lock') or self._index_lock is None:
            object.__setattr__(self, '_index_lock', threading.Lock())

    def __getstate__(self) -> dict:
        """pickle / deepcopy 时剔除不可复制的线程锁。

        store 用 copy.deepcopy 返回画布快照，而 threading.Lock 无法被复制，
        不剔除会直接抛 TypeError: cannot pickle '_thread.lock' object。
        """
        data = self.__dict__.copy()
        data.pop("_index_lock", None)
        return data

    def __setstate__(self, data: dict) -> None:
        self.__dict__.update(data)
        object.__setattr__(self, "_index_lock", threading.Lock())

    def to_dict(self) -> dict:
        return {
            "canvas_id": self.canvas_id,
            "nodes": {nid: node.to_dict() for nid, node in self.nodes.items()},
            "version": self.version,
            "name": self.name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "next_index": self.next_index,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CanvasState":
        nodes = {
            nid: CanvasNode.from_dict(ndata)
            for nid, ndata in data.get("nodes", {}).items()
        }
        # 老画布迁移：节点缺编号时按插入顺序补号（从现有最大编号之后递增，避免撞号）
        if any(n.index is None for n in nodes.values()):
            next_idx = max((n.index or 0) for n in nodes.values()) + 1 if nodes else 1
            for n in nodes.values():
                if n.index is None:
                    n.index = next_idx
                    next_idx += 1
            next_index = max(data.get("next_index", 1), next_idx)
        else:
            next_index = data.get("next_index", 1)
            if nodes:
                next_index = max(next_index, max(n.index or 0 for n in nodes.values()) + 1)
        return cls(
            canvas_id=data["canvas_id"],
            nodes=nodes,
            version=data.get("version", 0),
            name=data.get("name", "") or f"画布 {data['canvas_id'][:6]}",
            created_at=data.get("created_at", 0),
            updated_at=data.get("updated_at", 0),
            next_index=next_index,
        )

    def reserve_indices(self, count: int) -> list[int]:
        """一次性预留 count 个唯一编号（原子操作）。

        并行生图时每个工具在独立的 state 副本上执行，若各自从相同的 next_index
        自增，就会"抢注"到同一个编号。因此在派发前从主画布统一预留号段，
        每个副本以预留编号为起点，保证编号分配唯一、生成即最终值，不会被二次改写。
        """
        if count <= 0:
            return []
        with self._index_lock:
            existing = {n.index for n in self.nodes.values() if n.index is not None}
            reserved: list[int] = []
            while len(reserved) < count:
                idx = self.next_index
                self.next_index += 1
                if idx not in existing:
                    reserved.append(idx)
            return reserved

    def add_node(self, node: CanvasNode) -> None:
        # 统一编号分配：所有加节点路径（工具/上传/克隆）都经过这里
        # 使用锁保证原子性，避免并发操作导致编号冲突
        with self._index_lock:
            existing_indices = {n.index for n in self.nodes.values() if n.index is not None}
            if node.index is None or node.index in existing_indices:
                # 找到下一个可用的 index
                while self.next_index in existing_indices:
                    self.next_index += 1
                node.index = self.next_index
                self.next_index += 1
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


def create_canvas(name: str = "") -> CanvasState:
    """创建新画布"""
    now = time.time()
    return CanvasState(
        canvas_id=str(uuid.uuid4()),
        name=name,
        created_at=now,
        updated_at=now,
    )
