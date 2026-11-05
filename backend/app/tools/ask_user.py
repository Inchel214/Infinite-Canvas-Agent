"""ask_user 工具：Agent 向用户询问信息或确认操作，暂停执行等待回复"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.tools.base import BaseTool, ToolResult

if TYPE_CHECKING:
    from app.agent.react_loop import RunControl
    from app.canvas.state import CanvasState

logger = logging.getLogger(__name__)

# 默认超时时间（秒）
DEFAULT_TIMEOUT = 120  # 2 分钟


class AskUserTool(BaseTool):
    """向用户询问信息或确认操作，暂停执行等待用户回复。
    
    支持：
    - 选项列表（用户从中选择）
    - 自由输入（用户可输入任意内容）
    - 超时后走默认行为继续执行（不阻塞流程）
    """

    name = "ask_user"
    description = (
        "向用户询问信息或确认操作。当需要用户决策时调用此工具。"
        "调用后会暂停执行等待用户回复，用户回复后继续执行。"
        "支持选项列表和自由输入。如果用户超时未回复，将按默认行为继续执行。"
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
                "description": "可选选项列表（用户可从中选择，也可自由输入）",
            },
            "default_action": {
                "type": "string",
                "description": "超时或用户跳过时的默认行为描述（如：'取消操作'、'使用默认值'、'继续执行'）",
            },
            "timeout": {
                "type": "integer",
                "description": f"等待超时时间（秒），默认 {DEFAULT_TIMEOUT} 秒。超时后按默认行为继续执行",
            },
        },
        "required": ["question"],
    }

    def __init__(self, control: "RunControl"):
        self.control = control

    def run(self, state: "CanvasState", **kwargs) -> ToolResult:
        question = kwargs.get("question", "")
        options = kwargs.get("options", [])
        default_action = kwargs.get("default_action", "")
        timeout = kwargs.get("timeout", DEFAULT_TIMEOUT)
        canvas_id = state.canvas_id

        if not question:
            return ToolResult(
                success=False,
                message="问题不能为空",
                state=state,
            )

        # 限制超时范围：最少 30 秒，最多 10 分钟
        timeout = max(30, min(timeout, 600))

        logger.info(
            "[AskUser] 询问用户 canvas=%s question=%s options=%s timeout=%ds default=%s",
            canvas_id, question[:80], options, timeout, default_action[:50] if default_action else "无",
        )

        # 通过 control 暂停并等待用户回复
        question_data = {
            "question": question,
            "options": options,
            "default_action": default_action,
            "timeout": timeout,
        }

        # 请求暂停
        if not self.control.request_pause(canvas_id, question_data):
            return ToolResult(
                success=False,
                message="无法暂停执行（可能已被停止）",
                state=state,
            )

        # 阻塞等待用户回复
        user_response = self.control.wait_for_response(canvas_id, timeout=timeout)

        if user_response is None:
            # 超时或被停止：走默认行为继续执行
            if default_action:
                logger.info(
                    "[AskUser] 用户超时未回复，执行默认行为 canvas=%s default=%s",
                    canvas_id, default_action[:80],
                )
                return ToolResult(
                    success=True,
                    message=f"用户未回复（超时 {timeout} 秒），按默认行为继续：{default_action}",
                    state=state,
                )
            else:
                # 没有默认行为：让 Agent 自行决策
                logger.info(
                    "[AskUser] 用户超时未回复，由 Agent 自行决策 canvas=%s",
                    canvas_id,
                )
                return ToolResult(
                    success=True,
                    message=f"用户未回复（超时 {timeout} 秒），请根据上下文自行判断并继续执行。",
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
