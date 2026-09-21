"""依赖注入容器，初始化所有组件"""
import os

from app.agent.llm import MockLLM
from app.agent.react_loop import ReActAgent
from app.canvas.store import FileStore
from app.image.volc_generator import VolcEngineImageGenerator
from app.tools.base import ToolManager
from app.tools.compose_images import ComposeImagesTool
from app.tools.delete_node import DeleteNodeTool
from app.tools.edit_image import EditImageTool
from app.tools.generate_image import GenerateImageTool
from app.tools.list_nodes import ListNodesTool
from app.tools.move_node import MoveNodeTool
from app.tools.variate_image import VariateImageTool

# 单例组件：文件持久化存储，刷新/重启后画布状态不丢
store = FileStore()

# 图片生成服务：有 ARK_API_KEY 时用火山引擎真实 API，否则降级为 Mock（SVG 占位图）
_ark_api_key = os.getenv("ARK_API_KEY", "")
if _ark_api_key:
    image_generator = VolcEngineImageGenerator(
        api_key=_ark_api_key,
        model=os.getenv("ARK_IMAGE_MODEL", "doubao-seedream-5-0-pro-260628"),
    )
else:
    from app.image.mock_generator import MockImageGenerator

    image_generator = MockImageGenerator()

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

# Agent 大脑：有 ARK_API_KEY 时用方舟真实 LLM（function calling），否则降级为 Mock
if _ark_api_key:
    from app.agent.llm import ArkLLM

    llm = ArkLLM(
        api_key=_ark_api_key,
        model=os.getenv("ARK_LLM_MODEL", "doubao-seed-2-1-pro-260915"),
    )
else:
    llm = MockLLM()

agent = ReActAgent(
    llm=llm,
    tool_manager=tool_manager,
    store=store,
    max_steps=5,
)
