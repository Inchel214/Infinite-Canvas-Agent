"""ask_user 工具：Agent 向用户询问信息或确认操作，暂停执行等待回复"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.tools.base import BaseTool, ToolResult

if TYPE_CHECKING:
    from app.agent.react_loop import RunControl
    from app.canvas.state import CanvasState

logger = logging.getLogger(__name__)


class AskUserTool(BaseTool):
    """向用户询问信息或确认操作，暂停执行等待用户回复"""

    name = "ask_user"
    description = (
        "向用户询问信息或确认操作。当需要用户决策时调用此工具。"
        "调用后会暂停执行等待用户回复，用户回复后继续执行。"
        "适用场景：用户描述模糊需要澄清、多选项需要用户选择、危险操作前确认等。"
    )
    args_schema = {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "要问用户的问题",
            },
            "options": {
                "type": "array",
                "items": {"type": "string"},
                "description": "可选选项列表（如果提供，用户从中选择）",
            },
        },
        "required": ["question"],
    }

    def __init__(self, control: "RunControl"):
        self.control = control

    def run(self, state: "CanvasState", **kwargs) -> ToolResult:
        question = kwargs.get("question", "")
        options = kwargs.get("options", [])
        canvas_id = state.canvas_id

        if not question:
            return ToolResult(
                success=False,
                message="问题不能为空",
                state=state,
            )

        logger.info(
            "[AskUser] 询问用户 canvas=%s question=%s options=%s",
            canvas_id, question[:80], options,
        )

        # 通过 control 暂停并等待用户回复
        # 注意：实际的暂停和 SSE 事件推送由 ReActAgent 在工具执行前后处理
        # 这里只负责等待用户回复
        question_data = {
            "question": question,
            "options": options,
        }

        # 请求暂停
        if not self.control.request_pause(canvas_id, question_data):
            return ToolResult(
                success=False,
                message="无法暂停执行（可能已被停止）",
                state=state,
            )

        # 阻塞等待用户回复（最长 5 分钟）
        user_response = self.control.wait_for_response(canvas_id, timeout=300)

        if user_response is None:
            return ToolResult(
                success=False,
                message="等待用户回复超时或被停止",
                state=state,
            )

        logger.info(
            "[AskUser] 收到用户回复 canvas=%s response=%s",
            canvas_id, user_response[:80],
        )

        return ToolResult(
            success=True,
            message=f"用户回复：{user_response}",
            state=state,
        )
