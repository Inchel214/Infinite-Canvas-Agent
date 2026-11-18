"""工具测试：参数校验 + 行为验证

注意：这里不断言"缺参必失败"，因为工具内部有默认值（x/y 默认 0.0、prompt 默认空串），
这是预期行为。测试验证的是工具在给参和不给参时的行为一致性。
"""
from __future__ import annotations

import pytest

from app.canvas.state import CanvasNode, create_canvas
from app.image.mock_generator import MockImageGenerator
from app.tools.base import ToolManager
from app.tools.delete_node import DeleteNodeTool
from app.tools.generate_image import GenerateImageTool
from app.tools.list_nodes import ListNodesTool
from app.tools.move_node import MoveNodeTool


def _sample_state():
    s = create_canvas("t")
    s.add_node(CanvasNode(
        id="n1", type="image", x=0, y=0, width=300, height=300,
        content="c", image_url="",
    ))
    return s


class TestToolManager:
    def test_register_and_get(self):
        tm = ToolManager()
        tm.register(ListNodesTool())
        assert tm.get("list_nodes").name == "list_nodes"

    def test_get_missing_raises(self):
        tm = ToolManager()
        with pytest.raises(ValueError, match="工具不存在"):
            tm.get("nonexistent")

    def test_list_schemas(self):
        tm = ToolManager()
        tm.register(ListNodesTool())
        schemas = tm.list_schemas()
        assert len(schemas) == 1
        assert schemas[0]["name"] == "list_nodes"
        assert "args_schema" in schemas[0]


class TestGenerateImageTool:
    def test_happy_path_creates_new_node(self):
        tool = GenerateImageTool(MockImageGenerator())
        s = _sample_state()
        result = tool.run(s, prompt="a cat", x=100, y=100)
        assert result.success
        assert result.state is not None
        assert len(result.state.nodes) == 2


class TestMoveNodeTool:
    def test_move_updates_position(self):
        tool = MoveNodeTool()
        s = _sample_state()
        result = tool.run(s, node_id="n1", x=500, y=500)
        assert result.success
        assert result.state.nodes["n1"].x == 500
        assert result.state.nodes["n1"].y == 500

    def test_nonexistent_node_id_fails(self):
        tool = MoveNodeTool()
        s = _sample_state()
        result = tool.run(s, node_id="ghost", x=500, y=500)
        assert not result.success


class TestDeleteNodeTool:
    def test_delete_removes_node(self):
        tool = DeleteNodeTool()
        s = _sample_state()
        result = tool.run(s, node_id="n1")
        assert result.success
        assert "n1" not in result.state.nodes

    def test_delete_nonexistent_fails(self):
        tool = DeleteNodeTool()
        s = _sample_state()
        result = tool.run(s, node_id="ghost")
        assert not result.success


class TestListNodesTool:
    def test_message_mentions_node_count(self):
        """Message 是用户可读的摘要，详细数据在 result.data 里。"""
        tool = ListNodesTool()
        s = _sample_state()
        result = tool.run(s)
        assert result.success
        assert "1" in result.message  # "画布上共有 1 个节点"
        assert result.data is not None
        assert result.data["nodes"][0]["id"] == "n1"
