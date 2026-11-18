"""layout.py 自动布局测试"""
from __future__ import annotations

from app.canvas.state import CanvasNode, CanvasState, create_canvas
from app.tools.layout import (
    _BLOCK_GAP,
    _SOFT_GAP,
    next_position,
    next_position_near,
    semantic_arrange,
    soft_arrange,
)


def _add(state: CanvasState, nid: str, x, y, w=300, h=300, *, source_ids=None, group=""):
    node = CanvasNode(
        id=nid, type="image", x=x, y=y, width=w, height=h,
        source_ids=list(source_ids or []), group=group,
    )
    state.add_node(node)
    return node


def _rects_overlap(a, b, gap=0) -> bool:
    return (
        a.x - gap < b.x + b.width and a.x + a.width + gap > b.x
        and a.y - gap < b.y + b.height and a.y + a.height + gap > b.y
    )


def _rect_distance(r1, r2) -> float:
    """两个轴对齐矩形的最小距离（无重叠时），有重叠返回 0。"""
    # r1, r2: (x, y, w, h)
    dx1 = r2[0] - (r1[0] + r1[2])
    dx2 = r1[0] - (r2[0] + r2[2])
    dy1 = r2[1] - (r1[1] + r1[3])
    dy2 = r1[1] - (r2[1] + r2[3])
    dx = max(0, dx1, dx2)
    dy = max(0, dy1, dy2)
    return (dx ** 2 + dy ** 2) ** 0.5


class TestNextPosition:
    def test_empty_canvas(self):
        s = create_canvas("t")
        assert next_position(s, 300, 300) == (100.0, 100.0)

    def test_avoids_existing_node(self):
        s = create_canvas("t")
        _add(s, "a", x=100, y=100, w=300, h=300)
        px, py = next_position(s, 300, 300)
        new = CanvasNode(id="test", type="image", x=px, y=py, width=300, height=300)
        assert not _rects_overlap(s.nodes["a"], new)

    def test_returns_valid_fallback_when_rightmost_blocked(self):
        """即使右边一排都被占，next_position 也会在最右侧候选中返回一个自由位置，
        或者兜底到最右侧（数学上必然自由）。"""
        s = create_canvas("t")
        # 一排 4 个，每个 300px 宽，60px gap → 间距 360
        for i in range(4):
            _add(s, f"n{i}", x=100 + i * 360, y=100, w=300, h=300)
        px, py = next_position(s, 300, 300)
        # 结果必须避开所有现有节点
        new = CanvasNode(id="test", type="image", x=px, y=py, width=300, height=300)
        for existing in s.list_nodes():
            assert not _rects_overlap(existing, new)


class TestNextPositionNear:
    def test_result_is_near_reference(self):
        s = create_canvas("t")
        _add(s, "anchor", x=500, y=500, w=300, h=300)
        px, py = next_position_near(s, 300, 300, cx=650, cy=650)
        dist_to_anchor_center = ((px + 150 - 650) ** 2 + (py + 150 - 650) ** 2) ** 0.5
        # 环状扩散优先选参考点附近的候选
        assert dist_to_anchor_center < 2000

    def test_avoids_existing_node(self):
        s = create_canvas("t")
        _add(s, "anchor", x=500, y=500, w=300, h=300)
        px, py = next_position_near(s, 300, 300, cx=650, cy=650)
        new = CanvasNode(id="test", type="image", x=px, y=py, width=300, height=300)
        assert not _rects_overlap(s.nodes["anchor"], new)


class TestSoftArrange:
    def test_removes_overlap(self):
        s = create_canvas("t")
        _add(s, "a", x=100, y=100, w=300, h=300)
        _add(s, "b", x=250, y=250, w=300, h=300)  # 与 a 重叠

        result = soft_arrange(s)
        ax, ay = result["a"]
        bx, by = result["b"]
        a_new = CanvasNode(id="a", type="image", x=ax, y=ay, width=300, height=300)
        b_new = CanvasNode(id="b", type="image", x=bx, y=by, width=300, height=300)
        assert not _rects_overlap(a_new, b_new, gap=_SOFT_GAP)


class TestSemanticArrange:
    def test_source_parents_form_one_block(self):
        """有连线的节点被收到一个区块，与其他区块隔离。"""
        s = create_canvas("t")
        _add(s, "root", x=100, y=100, w=200, h=200)
        _add(s, "c1", x=800, y=100, w=200, h=200, source_ids=["root"])
        _add(s, "c2", x=800, y=500, w=200, h=200, source_ids=["root"])
        _add(s, "stranger", x=800, y=1000, w=200, h=200)

        result = semantic_arrange(s)
        # 找 root 簇的 bbox
        root_cluster = ["root", "c1", "c2"]
        xs = [result[n][0] for n in root_cluster]
        ys = [result[n][1] for n in root_cluster]
        root_bbox = (min(xs), min(ys), max(xs) + 200 - min(xs), max(ys) + 200 - min(ys))
        sx, sy = result["stranger"]
        str_bbox = (sx, sy, 200, 200)

        # 两个区块间的距离应该 >= _BLOCK_GAP
        d = _rect_distance(root_bbox, str_bbox)
        assert d >= _BLOCK_GAP - 1  # float 容差

    def test_same_group_nodes_clustered(self):
        s = create_canvas("t")
        _add(s, "a", x=100, y=100, w=200, h=200, group="req")
        _add(s, "b", x=1000, y=1000, w=200, h=200, group="req")
        _add(s, "c", x=500, y=500, w=200, h=200, group="design")

        result = semantic_arrange(s)
        ax, ay = result["a"]; bx, by = result["b"]; cx, cy = result["c"]
        ab_dist = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
        ac_dist = ((ax - cx) ** 2 + (ay - cy) ** 2) ** 0.5
        bc_dist = ((bx - cx) ** 2 + (by - cy) ** 2) ** 0.5
        assert ab_dist < ac_dist and ab_dist < bc_dist

    def test_empty_state_returns_empty_dict(self):
        s = create_canvas("t")
        assert semantic_arrange(s) == {}
        assert soft_arrange(s) == {}
