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


def next_position_near(
    state: CanvasState,
    width: float,
    height: float,
    cx: float,
    cy: float,
) -> tuple[float, float]:
    """
    在参考点 (cx, cy)（通常是参考图中心）附近寻找最近的空白位置：
    环状网格扩散（步长 = 新图尺寸 + 间隙），按到参考点的距离取最近的可行候选，
    距离相同时优先右侧、其次上方（与右键菜单"右侧 60px 顶部对齐"的直觉一致）。
    适用于派生图（编辑/变体/组合）落点——避免全画布扫描把新图放到大老远的空白区。
    扩散 12 环仍无解时回退全局 next_position。
    """
    step_x = width + _GAP
    step_y = height + _GAP
    # 网格锚点：让 (cx, cy) 恰是首个候选的中心，四周候选自然对齐
    base_x = cx - width / 2
    base_y = cy - height / 2

    for r in range(0, 13):
        ring: list[tuple[float, float, float]] = []
        for i in range(-r, r + 1):
            for j in range(-r, r + 1):
                if abs(i) != r and abs(j) != r:
                    continue  # 只取本环新增的格子，避免重复检查
                px = base_x + i * step_x
                py = base_y + j * step_y
                d = ((px + width / 2 - cx) ** 2 + (py + height / 2 - cy) ** 2) ** 0.5
                ring.append((d, px, py))
        # 距离升序；同距离优先 x 大（右）、再 y 小（上）
        ring.sort(key=lambda t: (t[0], -t[1], t[2]))
        for (_, px, py) in ring:
            if _is_free(state, px, py, width, height):
                return px, py

    # 兜底：就近区域全占满（理论上极难发生），退回全局扫描
    return next_position(state, width, height)


def arrange_canvas(state: CanvasState) -> dict[str, tuple[float, float]]:
    """
    按分组 + 连线关系整理（分组分区 + DAG 分层布局）：
    - 有 group 的节点按 group 分区（水平排列，每个 group 占据一列）
    - 无 group 的节点按原 DAG 分层逻辑（纵向族谱）
    - 每个分区/层级内部按父节点中心 x 对齐，连线更整齐
    返回 {node_id: (x, y)}；空画布返回空 dict。
    """
    nodes = [n for n in state.list_nodes() if n.type in ("image", "text")]
    if not nodes:
        return {}

    by_id = {n.id: n for n in nodes}
    # 只统计存在的父节点（连线来源）
    parents = {n.id: [p for p in n.source_ids if p in by_id] for n in nodes}

    # 1. 计算每个节点的深度（到根的最长路径）——迭代实现（Kahn 拓扑排序 + DP）
    depth: dict[str, int] = {nid: 0 for nid in parents}
    children: dict[str, list[str]] = {}
    indeg: dict[str, int] = {}
    for nid, ps in parents.items():
        uniq_ps = list(dict.fromkeys(ps))
        indeg[nid] = len(uniq_ps)
        for p in uniq_ps:
            children.setdefault(p, []).append(nid)
    queue = [nid for nid, d in indeg.items() if d == 0]
    processed = 0
    while queue:
        nid = queue.pop()
        processed += 1
        for c in children.get(nid, []):
            depth[c] = max(depth[c], depth[nid] + 1)
            indeg[c] -= 1
            if indeg[c] == 0:
                queue.append(c)

    # 2. 按 group 分组
    groups: dict[str, list] = {}
    for n in nodes:
        g = n.group or ""  # 空字符串表示"未分组"
        groups.setdefault(g, []).append(n)

    # 3. 分区布局：有 group 的按水平排列，无 group 的按原逻辑
    gap_x, gap_y = 120.0, 160.0
    group_gap = 200.0  # group 之间的水平间距
    start_x, start_y = 100.0, 100.0
    positions: dict[str, tuple[float, float]] = {}
    center_x: dict[str, float] = {}

    # 分离有 group 和无 group 的节点
    grouped_nodes = {g: ns for g, ns in groups.items() if g}
    ungrouped_nodes = groups.get("", [])

    # 处理有 group 的节点：每个 group 占据一列
    current_x = start_x
    for group_name in sorted(grouped_nodes.keys()):
        group_nodes = grouped_nodes[group_name]
        # 按深度分行
        layers: dict[int, list] = {}
        for n in group_nodes:
            layers.setdefault(depth[n.id], []).append(n)

        # 逐行放置
        y = start_y
        max_width = 0
        for d in range(max(layers) + 1):
            layer = layers.get(d, [])
            if not layer:
                continue

            def bary(n) -> float:
                ps = parents[n.id]
                if not ps:
                    return 0.0
                return sum(center_x.get(p, 0.0) for p in ps) / len(ps)

            layer_sorted = sorted(layer, key=bary)
            x = current_x
            row_h = max(n.height for n in layer)
            for n in layer_sorted:
                positions[n.id] = (x, y)
                center_x[n.id] = x + n.width / 2
                x += n.width + gap_x
            max_width = max(max_width, x - current_x)
            y += row_h + gap_y

        current_x += max_width + group_gap

    # 处理无 group 的节点：按原 DAG 分层逻辑
    if ungrouped_nodes:
        layers: dict[int, list] = {}
        for n in ungrouped_nodes:
            layers.setdefault(depth[n.id], []).append(n)

        y = start_y
        for d in range(max(layers) + 1):
            layer = layers.get(d, [])
            if not layer:
                continue

            def bary(n) -> float:
                ps = parents[n.id]
                if not ps:
                    return 0.0
                return sum(center_x.get(p, 0.0) for p in ps) / len(ps)

            layer_sorted = sorted(layer, key=bary)
            x = current_x if grouped_nodes else start_x
            row_h = max(n.height for n in layer)
            for n in layer_sorted:
                positions[n.id] = (x, y)
                center_x[n.id] = x + n.width / 2
                x += n.width + gap_x
            y += row_h + gap_y

    return positions
