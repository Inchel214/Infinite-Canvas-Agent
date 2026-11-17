"""测试共用 fixture。

注意：store.py 的 `materialize_state_images` 和 `normalize_state_image_sizes`
会依赖 IMAGES_DIR（backend/data/images/）。测试里通过 patch 把它临时指向
tmp_path 下的独立目录，避免污染真实数据目录。同理 SettingsStore 的路径。
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# 确保 backend/ 根目录在 sys.path 里（pytest.ini 的 pythonpath 已配，双保险）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.canvas.state import CanvasNode, CanvasState, create_canvas  # noqa: E402


# ---------- 构造画布节点的快捷 helper ----------

def make_node(
    nid: str,
    x: float = 0,
    y: float = 0,
    w: float = 300,
    h: float = 300,
    *,
    ntype: str = "image",
    content: str = "test",
    image_url: str = "",
    source_ids: list[str] | None = None,
    group: str = "",
) -> CanvasNode:
    return CanvasNode(
        id=nid,
        type=ntype,
        x=x,
        y=y,
        width=w,
        height=h,
        content=content,
        image_url=image_url,
        source_ids=list(source_ids or []),
        group=group,
    )


# ---------- Store fixture ----------

@pytest.fixture
def in_memory_store():
    from app.canvas.store import InMemoryStore

    return InMemoryStore()


@pytest.fixture
def file_store(tmp_path):
    """隔离的 FileStore：CANVAS_DATA_DIR 指向 tmp_path 子目录，同时 patch IMAGES_DIR
    避免 store 内部的 materialize_state_images 写到真实 backend/data/images/。"""
    data_dir = tmp_path / "canvases"
    data_dir.mkdir()
    images_dir = tmp_path / "images"
    images_dir.mkdir()

    from app.canvas import store as store_module
    from app.image import files as files_module

    with patch.object(files_module, "IMAGES_DIR", images_dir):
        from app.canvas.store import FileStore

        yield FileStore(data_dir=str(data_dir))


@pytest.fixture
def blank_canvas_store(file_store):
    """FileStore + 一个刚创建的空白画布，方便测试直接加节点。"""
    state = file_store.create_canvas("test-canvas")
    return file_store, state


# ---------- Provider / Settings fixture ----------

@pytest.fixture
def manager_under_test(tmp_path):
    """ProviderManager：SettingsStore 路径在 tmp_path 下，默认配置降级为 Mock。"""
    settings_dir = tmp_path / "settings"
    settings_dir.mkdir()

    from app.providers.store import SettingsStore
    from app.providers.manager import ProviderManager

    store = SettingsStore(settings_dir / "settings.json")
    mgr = ProviderManager(store=store)
    # 强制降级：显式设 mock，避免从 .env 读到真实 key 走网络
    from app.providers.schema import AppSettings

    mgr.update(AppSettings())
    return mgr


# ---------- Agent fixture ----------

@pytest.fixture
def agent_smoke_env(tmp_path):
    """Agent 冒烟测试环境：MockLLM + ToolManager + InMemoryStore，完全离线、零网络。"""
    from app.agent.llm import MockLLM
    from app.agent.react_loop import ReActAgent
    from app.canvas.store import InMemoryStore
    from app.tools.base import ToolManager

    # 两个最简单的"真实"工具，用于跑通 ReAct 循环
    from app.tools.list_nodes import ListNodesTool
    from app.tools.move_node import MoveNodeTool
    from app.tools.generate_image import GenerateImageTool
    from app.image.mock_generator import MockImageGenerator

    store = InMemoryStore()
    tm = ToolManager()
    tm.register(GenerateImageTool(MockImageGenerator()))
    tm.register(MoveNodeTool())
    tm.register(ListNodesTool())

    llm = MockLLM()
    agent = ReActAgent(llm=llm, tool_manager=tm, store=store, max_steps=10)
    return agent, store
