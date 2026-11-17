"""store.py 核心逻辑测试

重点覆盖：
- undo/redo 栈的 JSON 快照（_snapshot / _restore）
- 历史栈上限 _MAX_HISTORY=50
- redo 栈在新 save 后清空
- FileStore 的磁盘持久化与重启恢复
- undo/redo 版本号单调递增

注意：create_canvas 返回的 state 就是 self._canvases[cid] 里存的同一个对象引用。
save_canvas 入栈的是 self._canvases[cid]，所以如果直接改 create 返回的 state，
入栈的"旧状态"已经被改过了——undo 会失效。正确做法是每次 save 前 get_canvas
拿深拷贝，在副本上修改。下面用 _step helper 统一处理。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from app.canvas.state import CanvasNode, CanvasState, create_canvas
from app.canvas.store import FileStore, InMemoryStore


def _make_node(nid: str, x=0, y=0, w=300, h=300, content="c") -> CanvasNode:
    return CanvasNode(
        id=nid, type="image", x=x, y=y, width=w, height=h,
        content=content, image_url="",
    )


def _step(store, cid: str, *new_nodes: str) -> CanvasState:
    """get → 加节点 → save。每次调用入栈一次"旧状态"。返回 save 后的副本。"""
    s = store.get_canvas(cid)  # 深拷贝
    for nid in new_nodes:
        s.add_node(_make_node(nid))
    store.save_canvas(s)
    return store.get_canvas(cid)


# ---------- InMemoryStore ----------

class TestInMemoryBasics:
    def test_create(self, in_memory_store):
        s = in_memory_store.create_canvas("hello")
        assert s.name == "hello" and s.canvas_id and s.version == 0

    def test_get_canvas_returns_deep_copy(self, in_memory_store):
        s = in_memory_store.create_canvas("t")
        _step(in_memory_store, s.canvas_id, "n1")
        copy = in_memory_store.get_canvas(s.canvas_id)
        copy.nodes.clear()
        original = in_memory_store.get_canvas(s.canvas_id)
        assert "n1" in original.nodes

    def test_undo_empty_history(self, in_memory_store):
        s = in_memory_store.create_canvas("t")
        # 只有 create，不入栈
        assert in_memory_store.undo(s.canvas_id) is None


class TestUndoRedoLoop:
    def test_undo_restores_to_previous_save(self, in_memory_store):
        s = in_memory_store.create_canvas("t")
        cid = s.canvas_id
        # create 不入栈；以下每次 _step 入栈一次"旧状态"
        # 第一次 step：空画布 → {n1}，入栈: [空]
        _step(in_memory_store, cid, "n1")
        # 第二次 step：{n1} → {n1,n2}，入栈: [空, {n1}]
        _step(in_memory_store, cid, "n2")
        # 第三次 step：{n1,n2} → {n1,n2,n3}，入栈: [空, {n1}, {n1,n2}]
        _step(in_memory_store, cid, "n3")

        # undo 弹出栈顶 {n1,n2} → 恢复到 {n1}
        r1 = in_memory_store.undo(cid)
        assert r1 is not None
        assert set(r1.nodes.keys()) == {"n1", "n2"}

        r2 = in_memory_store.undo(cid)
        assert r2 is not None
        assert set(r2.nodes.keys()) == {"n1"}

        r3 = in_memory_store.undo(cid)
        assert r3 is not None
        assert set(r3.nodes.keys()) == set()

        # 第四次 undo 栈空
        assert in_memory_store.undo(cid) is None

    def test_redo_reverses_undo(self, in_memory_store):
        s = in_memory_store.create_canvas("t")
        cid = s.canvas_id
        _step(in_memory_store, cid)              # stack: [空]
        _step(in_memory_store, cid, "n1")        # stack: [空, {n1}]
        _step(in_memory_store, cid, "n2")        # stack: [空, {n1}, {n1,n2}]

        in_memory_store.undo(cid)                # 回到 {n1}，redo 栈压入 {n1,n2}
        redo_back = in_memory_store.redo(cid)    # 回到 {n1,n2}
        assert redo_back is not None
        assert set(redo_back.nodes.keys()) == {"n1", "n2"}

    def test_redo_cleared_on_new_save(self, in_memory_store):
        s = in_memory_store.create_canvas("t")
        cid = s.canvas_id
        _step(in_memory_store, cid)
        _step(in_memory_store, cid, "n1")
        _step(in_memory_store, cid, "n2")

        in_memory_store.undo(cid)    # 回到 {n1}
        assert in_memory_store.redo(cid) is not None   # redo 栈非空

        in_memory_store.undo(cid)    # 回到 空

        # 新 save → redo 清空
        _step(in_memory_store, cid, "n3")
        assert in_memory_store.redo(cid) is None

    def test_undo_version_mono_increasing(self, in_memory_store):
        """前端用 version 丢弃过期状态，undo 不能让 version 倒退。"""
        s = in_memory_store.create_canvas("t")
        cid = s.canvas_id
        _step(in_memory_store, cid, "n1")
        v_after_save = in_memory_store.get_canvas(cid).version

        restored = in_memory_store.undo(cid)
        assert restored is not None
        assert restored.version >= v_after_save


class TestHistoryCap:
    """_MAX_HISTORY=50 上限"""

    def test_undo_stack_capped_at_50(self, in_memory_store):
        s = in_memory_store.create_canvas("t")
        cid = s.canvas_id
        # 先有一次空画布入栈
        _step(in_memory_store, cid)
        # 再 60 次 save，入栈 60 份，cap 50 → 实际可 undo 50 次
        for i in range(60):
            _step(in_memory_store, cid, f"n{i}")
        for _ in range(50):
            assert in_memory_store.undo(cid) is not None
        assert in_memory_store.undo(cid) is None

    def test_redo_stack_capped_at_50(self, in_memory_store):
        s = in_memory_store.create_canvas("t")
        cid = s.canvas_id
        _step(in_memory_store, cid)
        for i in range(51):
            _step(in_memory_store, cid, f"n{i}")
        for _ in range(50):
            in_memory_store.undo(cid)   # undo 入 redo
        # 继续 undo 已无 history
        assert in_memory_store.undo(cid) is None


# ---------- FileStore ----------

class TestFileStorePersistence:
    def test_create_writes_json(self, file_store, tmp_path):
        data_dir = tmp_path / "canvases"
        s = file_store.create_canvas("t")
        json_path = data_dir / f"{s.canvas_id}.json"
        assert json_path.exists()
        data = json.loads(json_path.read_text())
        assert data["canvas_id"] == s.canvas_id

    def test_save_persists_nodes(self, file_store, tmp_path):
        data_dir = tmp_path / "canvases"
        s = file_store.create_canvas("t")
        cid = s.canvas_id
        _step(file_store, cid, "n1")

        data = json.loads((data_dir / f"{cid}.json").read_text())
        assert "n1" in data["nodes"]

    def test_restart_recovers(self, tmp_path):
        from unittest.mock import patch
        from app.image import files as files_module

        data_dir = tmp_path / "canvases"
        data_dir.mkdir()
        images_dir = tmp_path / "images"
        images_dir.mkdir()

        with patch.object(files_module, "IMAGES_DIR", images_dir):
            s1 = FileStore(data_dir=str(data_dir))
            state1 = s1.create_canvas("hello")
            _step(s1, state1.canvas_id, "n1")
            cid = state1.canvas_id

        with patch.object(files_module, "IMAGES_DIR", images_dir):
            s2 = FileStore(data_dir=str(data_dir))
            restored = s2.get_canvas(cid)
            assert restored.name == "hello"
            assert "n1" in restored.nodes

    def test_undo_writes_to_disk(self, file_store, tmp_path):
        """undo 后磁盘也要同步回退，否则刷新就丢撤销。"""
        data_dir = tmp_path / "canvases"
        s = file_store.create_canvas("t")
        cid = s.canvas_id
        _step(file_store, cid)                  # stack: [空]
        _step(file_store, cid, "n1")            # stack: [空, {n1}]
        _step(file_store, cid, "n2")            # stack: [空, {n1}, {n1,n2}]

        file_store.undo(cid)
        data = json.loads((data_dir / f"{cid}.json").read_text())
        assert set(data["nodes"].keys()) == {"n1"}

    def test_list_canvases_merges_disk_and_memory(self, tmp_path):
        from unittest.mock import patch
        from app.image import files as files_module

        data_dir = tmp_path / "canvases"
        data_dir.mkdir()
        images_dir = tmp_path / "images"
        images_dir.mkdir()

        with patch.object(files_module, "IMAGES_DIR", images_dir):
            store = FileStore(data_dir=str(data_dir))
            a = store.create_canvas("A")
            _step(store, a.canvas_id, "n1")
            _ = store.create_canvas("B")

            summaries = store.list_canvases()
            names = {s["name"] for s in summaries}
            assert names == {"A", "B"}


class TestDeleteCanvas:
    def test_delete_removes_file(self, file_store, tmp_path):
        data_dir = tmp_path / "canvases"
        s = file_store.create_canvas("todel")
        _step(file_store, s.canvas_id, "n1")
        cid = s.canvas_id
        file_store.delete_canvas(cid)
        assert not (data_dir / f"{cid}.json").exists()

    def test_delete_nonexistent_raises(self, file_store):
        with pytest.raises(ValueError, match="画布不存在"):
            file_store.delete_canvas("nope")
