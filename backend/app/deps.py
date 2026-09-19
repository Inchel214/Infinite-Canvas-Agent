"""依赖注入容器，初始化所有组件"""
import os

from app.agent.llm import MockLLM
from app.agent.react_loop import ReActAgent
from app.canvas.store import InMemoryStore
from app.image.volc_generator import VolcEngineImageGenerator
from app.tools.base import ToolManager
from app.tools.compose_images import ComposeImagesTool
from app.tools.delete_node import DeleteNodeTool
from app.tools.edit_image import EditImageTool
from app.tools.generate_image import GenerateImageTool
from app.tools.list_nodes import ListNodesTool
from app.tools.move_node import MoveNodeTool
from app.tools.variate_image import VariateImageTool

# 单例组件
store = InMemoryStore()

# 图片生成服务：火山引擎方舟 Doubao Seedream 5.0 Pro 真实 API
image_generator = VolcEngineImageGenerator(
    api_key=os.getenv("ARK_API_KEY", ""),
    model=os.getenv("ARK_IMAGE_MODEL", "doubao-seedream-5-0-pro-260628"),
)

tool_manager = ToolManager()
# 图片生成工具
tool_manager.register(GenerateImageTool(image_generator))
tool_manager.register(VariateImageTool(image_generator))
tool_manager.register(EditImageTool(image_generator))
tool_manager.register(ComposeImagesTool(image_generator))
# 画布通用操作
tool_manager.register(MoveNodeTool())
tool_manager.register(DeleteNodeTool())
tool_manager.register(ListNodesTool())

# MVP 用 MockLLM，后续可替换为真实模型
llm = MockLLM()

agent = ReActAgent(
    llm=llm,
    tool_manager=tool_manager,
    store=store,
    max_steps=5,
)
