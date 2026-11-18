"""用户偏好与历史配方读取工具。"""
import json

from app.canvas.state import CanvasState
from app.feedback import FeedbackStore
from app.memory import MemoryStore
from app.tools.base import BaseTool, ToolResult


class SaveMemoryTool(BaseTool):
    name = "save_memory"
    description = "保存用户明确要求长期遵循的偏好；隐式反馈必须先经 ask_user 确认"
    args_schema = {"type": "object", "properties": {"text": {"type": "string"}, "preference_id": {"type": "string", "description": "覆盖已有偏好的 ID（可选）"}}, "required": ["text"]}

    def __init__(self, store: MemoryStore):
        self.store = store

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        item = self.store.save(kwargs.get("text", ""), kwargs.get("source_round", ""), kwargs.get("preference_id", ""))
        return ToolResult(success=True, message=f"已记住偏好：{item['text']}", state=state, data=item)


class ReadMemoryTool(BaseTool):
    name = "read_memory"
    description = "读取全部长期偏好；系统提示词只包含精简目录"
    args_schema = {"type": "object", "properties": {}}

    def __init__(self, store: MemoryStore):
        self.store = store

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        return ToolResult(success=True, message=json.dumps({"items": self.store.list()}, ensure_ascii=False), state=state)


class ReadRecipeTool(BaseTool):
    name = "read_recipe"
    description = "按需查询本画布最近 5 条匹配图片配方及保留/删除/重试/编辑/克隆反馈"
    args_schema = {"type": "object", "properties": {"keywords": {"type": "array", "items": {"type": "string"}}, "style": {"type": "string"}}}

    def __init__(self, store: FeedbackStore):
        self.store = store

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        records = self.store.query(state.canvas_id, kwargs.get("keywords") or [], kwargs.get("style", ""))
        return ToolResult(success=True, message=json.dumps({"recipes": records}, ensure_ascii=False), state=state, data={"recipes": records})
