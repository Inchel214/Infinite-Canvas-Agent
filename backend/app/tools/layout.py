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
    按连线关系层次整理（DAG 分层布局，纵向族谱）：
    - 根图（无来源连线）排最上排
    - 派生图按依赖层级（最长路径深度）向下展开，生成链从上到下流动（滚轮即可浏览）
    - 同层节点水平排列，顺序按父节点中心 x（中点启发式）对齐，连线更整齐
    返回 {node_id: (x, y)}；空画布返回空 dict。
    """
    nodes = [n for n in state.list_nodes() if n.type in ("image", "text")]
    if not nodes:
        return {}

    by_id = {n.id: n for n in nodes}
    # 只统计存在的父节点（连线来源）
    parents = {n.id: [p for p in n.source_ids if p in by_id] for n in nodes}

    # 1. 计算每个节点的深度（到根的最长路径）——迭代实现（Kahn 拓扑排序 + DP）：
    #    递归版在长派生链（>1000 层）且链尾先被遍历时会 RecursionError → 接口 500
    depth: dict[str, int] = {nid: 0 for nid in parents}
    children: dict[str, list[str]] = {}
    indeg: dict[str, int] = {}
    for nid, ps in parents.items():
        # 去重父节点（多连线指向同一图时入度只算一次，避免漏处理）
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
    # 剩余未处理的节点属于环（或挂在环下游）：深度保持 0，归入最上排，不阻塞整理

    # 2. 按深度分行
    layers: dict[int, list] = {}
    for n in nodes:
        layers.setdefault(depth[n.id], []).append(n)

    # 3. 逐行从上到下放置；行内按父节点中心 x（中点）排序，
    #    使子图尽量对着父图，连线短且不交叉；无父的保持原顺序
    gap_x, gap_y = 120.0, 160.0
    start_x, start_y = 100.0, 100.0
    positions: dict[str, tuple[float, float]] = {}
    center_x: dict[str, float] = {}

    y = start_y
    for d in range(max(layers) + 1):
        layer = layers.get(d, [])
        if not layer:
            continue  # 环回溯产生的空洞层

        def bary(n) -> float:
            ps = parents[n.id]
            if not ps:
                return 0.0
            return sum(center_x.get(p, 0.0) for p in ps) / len(ps)

        # 稳定排序：bary 相同（如同为 0）时保持创建顺序
        layer_sorted = sorted(layer, key=bary)
        x = start_x
        row_h = max(n.height for n in layer)
        for n in layer_sorted:
            positions[n.id] = (x, y)
            center_x[n.id] = x + n.width / 2
            x += n.width + gap_x
        y += row_h + gap_y

    return positions
