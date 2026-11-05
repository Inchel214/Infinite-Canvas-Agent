"""技能读取工具：Agent 按需读取技能库全文，融入生图 prompt"""
from __future__ import annotations

from app.canvas.state import CanvasState
from app import experiences
from app.tools.base import BaseTool, ToolResult


class ReadExperienceTool(BaseTool):
    name = "read_experience"
    description = "读取技能库中一份技能的全文。当用户需求与某个技能匹配时，先读全文再把技能要点融入生图 prompt"
    args_schema = {
        "type": "object",
        "properties": {
            "experience_id": {"type": "string", "description": "技能 ID（见 System Prompt 技能库目录）"},
        },
        "required": ["experience_id"],
    }

    def run(self, state: CanvasState, **kwargs) -> ToolResult:
        exp_id = str(kwargs.get("experience_id", ""))
        exp = experiences.read_experience(exp_id)
        if not exp:
            return ToolResult(
                success=False,
                message=f"技能不存在: {exp_id}，请检查 System Prompt 中的技能库目录",
                state=state,
            )
        return ToolResult(
            success=True,
            message=f"技能《{exp['name']}》全文：\n{exp['content']}",
            state=state,
        )
