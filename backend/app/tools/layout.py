"""画布节点自动布局辅助"""
from __future__ import annotations

from app.canvas.state import CanvasState


def next_position(state: CanvasState, width: float, height: float) -> tuple[float, float]:
    """
    计算下一个节点的放置位置，避免与已有节点重叠。
    采用简单的网格布局：2 列，从上到下、从左到右排列。
    """
    # 只计算图片/可视节点的数量（排除可能的辅助节点）
    existing = [n for n in state.list_nodes() if n.type in ("image", "text", "shape")]
    n = len(existing)
    gap = 30
    x = 100 + (n % 2) * (width + gap)
    y = 100 + (n // 2) * (height + gap)
    return x, y
