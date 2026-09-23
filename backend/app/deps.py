"""依赖注入容器，初始化所有组件。

LLM / 图片生成器由 ProviderManager 统一管理：
配置优先级为 前端用户设置 > .env 环境变量 > Mock 降级，
更新配置（PUT /api/settings）后热切换生效，无需重启。
"""
from app.agent.react_loop import ReActAgent
from app.canvas.store import FileStore
from app.providers.manager import GeneratorProxy, LLMProxy, ProviderManager
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

# 服务商管理器：解析用户设置 / .env，构建当前生效的 generator 与 llm
manager = ProviderManager()

# 工具与 Agent 注入代理：配置热切换后自动指向新实例
tool_manager = ToolManager()
tool_manager.register(GenerateImageTool(GeneratorProxy(manager)))
tool_manager.register(VariateImageTool(GeneratorProxy(manager)))
tool_manager.register(EditImageTool(GeneratorProxy(manager)))
tool_manager.register(ComposeImagesTool(GeneratorProxy(manager)))
# 画布通用操作
tool_manager.register(MoveNodeTool())
tool_manager.register(DeleteNodeTool())
tool_manager.register(ListNodesTool())

agent = ReActAgent(
    llm=LLMProxy(manager),
    tool_manager=tool_manager,
    store=store,
    max_steps=5,
)
