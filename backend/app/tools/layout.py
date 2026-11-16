"""画布节点自动布局辅助：避让已有图片与连线 + 自动整理（轻整理 / 语义分区）"""
from __future__ import annotations

import math

from app.canvas.state import CanvasState

# 间隙与安全边距（世界坐标 px）
_GAP = 60.0
_PAD = 24.0
# 轻整理：节点之间至少保留的间距
_SOFT_GAP = 40.0
# 语义分区：块内间距、块间距、块内最多列数
_INNER_GAP = 60.0
_BLOCK_GAP = 200.0
_MAX_COLS = 6


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


def _arrange_nodes(state: CanvasState, exclude_ids) -> list:
    """参与整理的节点（图片/文本），exclude_ids 里的节点保持原位（如折叠的图片组）"""
    excl = set(exclude_ids or ())
    return [n for n in state.list_nodes()
            if n.type in ("image", "text") and n.id not in excl]


def _pair_overlap(ax: float, ay: float, a, bx: float, by: float, b, gap: float):
    """两个矩形（含间距 gap）的重叠量；不重叠返回 None"""
    dx = (ax + a.width / 2) - (bx + b.width / 2)
    dy = (ay + a.height / 2) - (by + b.height / 2)
    ox = (a.width + b.width) / 2 + gap - abs(dx)
    oy = (a.height + b.height) / 2 + gap - abs(dy)
    if ox <= 0 or oy <= 0:
        return None
    return dx, dy, ox, oy


def _rects_intersect(a: tuple[float, float, float, float],
                     b: tuple[float, float, float, float], gap: float) -> bool:
    return (a[0] < b[0] + b[2] + gap and a[0] + a[2] + gap > b[0]
            and a[1] < b[1] + b[3] + gap and a[1] + a[3] + gap > b[1])


def soft_arrange(state: CanvasState, exclude_ids=()) -> dict[str, tuple[float, float]]:
    """轻整理：只把重叠 / 过密的节点按最小位移推开，尽量保持原有位置与视角。

    - 沿重叠更小的一轴、双方各让一半位移（最小扰动）
    - exclude_ids（如折叠图片组内的节点）视为固定障碍，只推开其他节点
    - 不做网格或层级重排，整体布局关系不变
    """
    movable = _arrange_nodes(state, exclude_ids)
    if not movable:
        return {}
    excl = set(exclude_ids or ())
    fixed = [n for n in state.list_nodes()
             if n.type in ("image", "text") and n.id in excl]
    pos = {n.id: [float(n.x), float(n.y)] for n in movable}
    order = sorted(
        movable,
        key=lambda n: (n.index if n.index is not None else 10**9, n.id),
    )

    for _ in range(60):
        moved = False
        for i, a in enumerate(order):
            for b in order[i + 1:]:
                hit = _pair_overlap(*pos[a.id], a, *pos[b.id], b, _SOFT_GAP)
                if hit is None:
                    continue
                dx, dy, ox, oy = hit
                if ox < oy:
                    sign = 1.0 if dx >= 0 else -1.0
                    pos[a.id][0] += sign * ox / 2
                    pos[b.id][0] -= sign * ox / 2
                else:
                    sign = 1.0 if dy >= 0 else -1.0
                    pos[a.id][1] += sign * oy / 2
                    pos[b.id][1] -= sign * oy / 2
                moved = True
            for f in fixed:
                hit = _pair_overlap(*pos[a.id], a, f.x, f.y, f, _SOFT_GAP)
                if hit is None:
                    continue
                dx, dy, ox, oy = hit
                if ox < oy:
                    pos[a.id][0] += ox if dx >= 0 else -ox
                else:
                    pos[a.id][1] += oy if dy >= 0 else -oy
                moved = True
        if not moved:
            break

    return {nid: (round(x, 1), round(y, 1)) for nid, (x, y) in pos.items()}


def semantic_arrange(state: CanvasState, exclude_ids=()) -> dict[str, tuple[float, float]]:
    """语义分区整理：把有连线 / 同 group 的图收成一个区块，块内排成整齐网格，
    区块仍留在各自原来的大致位置，尽量保留用户的空间记忆。"""
    nodes = _arrange_nodes(state, exclude_ids)
    if not nodes:
        return {}
    by_id = {n.id: n for n in nodes}

    # 1. 并查集：连线关系 + 同名 group 归入同一区块
    uf = {n.id: n.id for n in nodes}

    def find(x: str) -> str:
        while uf[x] != x:
            uf[x] = uf[uf[x]]
            x = uf[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            uf[rb] = ra

    parents = {
        n.id: [p for p in dict.fromkeys(n.source_ids) if p in by_id] for n in nodes
    }
    for nid, ps in parents.items():
        for p in ps:
            union(nid, p)
    group_anchor: dict[str, str] = {}
    for n in nodes:
        if n.group:
            if n.group in group_anchor:
                union(n.id, group_anchor[n.group])
            else:
                group_anchor[n.group] = n.id

    # 2. 块内拓扑深度（父在前、子在后），用于块内排序
    children: dict[str, list[str]] = {}
    indeg = {nid: len(ps) for nid, ps in parents.items()}
    for nid, ps in parents.items():
        for p in ps:
            children.setdefault(p, []).append(nid)
    depth = {nid: 0 for nid in parents}
    queue = [nid for nid, d in indeg.items() if d == 0]
    while queue:
        nid = queue.pop()
        for c in children.get(nid, []):
            depth[c] = max(depth[c], depth[nid] + 1)
            indeg[c] -= 1
            if indeg[c] == 0:
                queue.append(c)

    blocks: dict[str, list] = {}
    for n in nodes:
        blocks.setdefault(find(n.id), []).append(n)

    excl = set(exclude_ids or ())
    obstacles = [
        (n.x, n.y, n.width, n.height)
        for n in state.list_nodes()
        if n.id in excl and n.type in ("image", "text")
    ]

    placed: list[tuple[float, float, float, float]] = []
    result: dict[str, tuple[float, float]] = {}

    # 3. 块按当前左上角排序，逐块就近放置：与已放置块冲突时向右让位
    for members in sorted(blocks.values(),
                          key=lambda ns: (min(n.y for n in ns), min(n.x for n in ns))):
        members.sort(key=lambda n: (
            depth.get(n.id, 0),
            n.index if n.index is not None else 10**9,
            n.x, n.y, n.id,
        ))
        cols = max(1, min(len(members), _MAX_COLS))
        rows = math.ceil(len(members) / cols)
        cell_w = max(n.width for n in members)
        cell_h = max(n.height for n in members)
        block_w = cols * cell_w + (cols - 1) * _INNER_GAP
        block_h = rows * cell_h + (rows - 1) * _INNER_GAP

        bx = min(n.x for n in members)
        by = min(n.y for n in members)
        for _ in range(200):
            rect = (bx, by, block_w, block_h)
            hit = next(
                (r for r in placed + obstacles
                 if _rects_intersect(rect, r, _BLOCK_GAP)),
                None,
            )
            if hit is None:
                break
            bx = hit[0] + hit[2] + _BLOCK_GAP
        placed.append((bx, by, block_w, block_h))

        for i, n in enumerate(members):
            row, col = divmod(i, cols)
            x = bx + col * (cell_w + _INNER_GAP) + (cell_w - n.width) / 2
            y = by + row * (cell_h + _INNER_GAP) + (cell_h - n.height) / 2
            result[n.id] = (round(x, 1), round(y, 1))

    return result


def arrange_canvas(state: CanvasState, mode: str = "semantic",
                   exclude_ids=()) -> dict[str, tuple[float, float]]:
    """自动整理入口。

    mode="soft"     ：轻整理，只消除重叠/过密，最大限度保留原布局
    mode="semantic" ：语义分区，按连线/分组收块，块内网格、块间留白
    返回 {node_id: (x, y)}；空画布返回空 dict。
    """
    if mode == "soft":
        return soft_arrange(state, exclude_ids)
    return semantic_arrange(state, exclude_ids)
