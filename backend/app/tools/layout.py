"""画布节点自动布局辅助：避让已有图片与连线 + 按连线层次整理"""
from __future__ import annotations

from app.canvas.state import CanvasState

# 间隙与安全边距（世界坐标 px）
_GAP = 60.0
_PAD = 24.0


def _segments(state: CanvasState) -> list[tuple[float, float, float, float]]:
    """所有连线段（源图中心 → 目标图中心），用于避让"""
    segs: list[tuple[float, float, float, float]] = []
    for n in state.list_nodes():
        for sid in n.source_ids:
            s = state.get_node(sid)
            if s:
                segs.append(
                    (
                        s.x + s.width / 2,
                        s.y + s.height / 2,
                        n.x + n.width / 2,
                        n.y + n.height / 2,
                    )
                )
    return segs


def _orient(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _seg_hits_rect(
    x1: float, y1: float, x2: float, y2: float, rx: float, ry: float, rw: float, rh: float
) -> bool:
    """线段是否穿过矩形（端点在内 或 与任一边相交）"""
    if rx <= x1 <= rx + rw and ry <= y1 <= ry + rh:
        return True
    if rx <= x2 <= rx + rw and ry <= y2 <= ry + rh:
        return True

    def seg_cross(ax, ay, bx, by, cx, cy, dx, dy) -> bool:
        o1 = _orient(ax, ay, bx, by, cx, cy)
        o2 = _orient(ax, ay, bx, by, dx, dy)
        o3 = _orient(cx, cy, dx, dy, ax, ay)
        o4 = _orient(cx, cy, dx, dy, bx, by)
        # 任一为 0（共线/过端点）保守视为相交
        if 0 in (o1, o2, o3, o4):
            return True
        return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0)

    edges = [
        (rx, ry, rx + rw, ry),          # 上
        (rx, ry + rh, rx + rw, ry + rh),  # 下
        (rx, ry, rx, ry + rh),          # 左
        (rx + rw, ry, rx + rw, ry + rh),  # 右
    ]
    return any(seg_cross(x1, y1, x2, y2, *e) for e in edges)


def _is_free(
    state: CanvasState,
    x: float,
    y: float,
    width: float,
    height: float,
) -> bool:
    """(x, y) 处放 width×height 的新节点是否避开了所有已有节点和连线"""
    px, py = x - _PAD, y - _PAD
    pw, ph = width + 2 * _PAD, height + 2 * _PAD
    for n in state.list_nodes():
        if n.type not in ("image", "text", "shape"):
            continue
        if px < n.x + n.width and px + pw > n.x and py < n.y + n.height and py + ph > n.y:
            return False
    for (x1, y1, x2, y2) in _segments(state):
        if _seg_hits_rect(x1, y1, x2, y2, px, py, pw, ph):
            return False
    return True


def next_position(state: CanvasState, width: float, height: float) -> tuple[float, float]:
    """
    为新节点寻找无重叠、无连线穿越的位置：
    1. 优先填各行最短处（每个已有节点右侧、顶部对齐，按 x 从小到大试）
    2. 都不行则放全部内容下方
    3. 兜底放全部内容最右侧
    """
    nodes = [n for n in state.list_nodes() if n.type in ("image", "text", "shape")]
    if not nodes:
        return 100.0, 100.0

    # 候选：各节点右侧，顶部对齐；按候选 x 升序 → 优先补最短的行
    candidates = sorted(
        ((n.x + n.width + _GAP, n.y) for n in nodes), key=lambda c: c[0]
    )
    for (cx, cy) in candidates:
        if _is_free(state, cx, cy, width, height):
            return cx, cy

    # 全部内容下方
    min_x = min(n.x for n in nodes)
    max_y = max(n.y + n.height for n in nodes)
    if _is_free(state, min_x, max_y + _GAP, width, height):
        return min_x, max_y + _GAP

    # 兜底：全部内容最右侧（数学上必然无重叠）
    max_x = max(n.x + n.width for n in nodes)
    min_y = min(n.y for n in nodes)
    return max_x + _GAP, min_y


def arrange_canvas(state: CanvasState) -> dict[str, tuple[float, float]]:
    """
    按连线关系层次整理（DAG 分层布局）：
    - 根图（无来源连线）排最左列
    - 派生图按依赖层级（最长路径深度）向右展开，生成链从左到右流动
    - 同层节点垂直排列，顺序按父节点中心 y（中点启发式）对齐，连线更整齐
    返回 {node_id: (x, y)}；空画布返回空 dict。
    """
    nodes = [n for n in state.list_nodes() if n.type in ("image", "text")]
    if not nodes:
        return {}

    by_id = {n.id: n for n in nodes}
    # 只统计存在的父节点（连线来源）
    parents = {n.id: [p for p in n.source_ids if p in by_id] for n in nodes}

    # 1. 计算每个节点的深度（到根的最长路径）
    depth: dict[str, int] = {}

    def get_depth(nid: str) -> int:
        if nid in depth:
            return depth[nid]
        depth[nid] = 0  # 防环：先置 0 再回溯
        ps = parents.get(nid, [])
        d = max((get_depth(p) for p in ps), default=-1) + 1 if ps else 0
        depth[nid] = d
        return d

    for n in nodes:
        get_depth(n.id)

    # 2. 按深度分列
    layers: dict[int, list] = {}
    for n in nodes:
        layers.setdefault(depth[n.id], []).append(n)

    # 3. 逐列从左到右放置；列内按父节点中心 y（中点）排序，
    #    使子图尽量对着父图，连线短且不交叉；无父的保持原顺序
    gap_x, gap_y = 160.0, 120.0
    start_x, start_y = 100.0, 100.0
    positions: dict[str, tuple[float, float]] = {}
    center_y: dict[str, float] = {}

    x = start_x
    for d in range(max(layers) + 1):
        layer = layers.get(d, [])
        if not layer:
            continue  # 防环回溯产生的空洞层

        def bary(n) -> float:
            ps = parents[n.id]
            if not ps:
                return 0.0
            return sum(center_y.get(p, 0.0) for p in ps) / len(ps)

        # 稳定排序：bary 相同（如同为 0）时保持创建顺序
        layer_sorted = sorted(layer, key=bary)
        y = start_y
        col_w = max(n.width for n in layer)
        for n in layer_sorted:
            positions[n.id] = (x, y)
            center_y[n.id] = y + n.height / 2
            y += n.height + gap_y
        x += col_w + gap_x

    return positions
