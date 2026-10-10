"""风格指南读取工具：Agent 按需读取风格库全文，融入生图 prompt"""
from __future__ import annotations

from app.canvas.state import CanvasState
from app import experiences
from app.tools.base import BaseTool, ToolResult


class ReadExperienceTool(BaseTool):
    name = "read_experience"
    description = "读取风格库中一份风格指南的全文。当用户需求与某个风格匹配时，先读全文再把风格要点融入生图 prompt"
    args_schema = {
        "type": "object",
        "properties": {
            "experience_id": {"type": "string", "description": "风格 ID（见 System Prompt 风格库目录）"},
        },
        "required": ["experience_id"],
    }

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        exp_id = str(kwargs.get("experience_id", ""))
        exp = experiences.read_experience(exp_id)
        if not exp:
            return ToolResult(
                success=False,
                message=f"风格不存在: {exp_id}，请检查 System Prompt 中的风格库目录",
                state=state,
            )
        return ToolResult(
            success=True,
            message=f"风格《{exp['name']}》全文：\n{exp['content']}",
            state=state,
        )
