"""ReAct Agent 循环（自研，预留 LangGraph 迁移点）"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from app.agent.llm import BaseLLM, LLMResponse, ToolCall
from app.agent.prompts import SYSTEM_PROMPT
from app.canvas.state import CanvasState
from app.canvas.store import BaseStore
from app.tools.base import ToolManager, ToolResult


@dataclass
class AgentResult:
    """Agent 执行结果"""
    success: bool
    message: str
    state: CanvasState
    steps: list[dict] = field(default_factory=list)


class ReActAgent:
    """
    ReAct 循环：思考 -> 调用工具 -> 观察结果 -> 继续/终止

    扩展点：后续可替换为 LangGraph 实现，接口保持不变。
    """

    def __init__(
        self,
        llm: BaseLLM,
        tool_manager: ToolManager,
        store: BaseStore,
        max_steps: int = 5,
    ):
        self.llm = llm
        self.tool_manager = tool_manager
        self.store = store
        self.max_steps = max_steps

    def run(self, prompt: str, canvas_id: str) -> AgentResult:
        """执行 Agent 循环"""
        state = self.store.get_canvas(canvas_id)
        messages: list[dict] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self._build_user_message(prompt, state)},
        ]

        steps: list[dict] = []

        for step in range(self.max_steps):
            response = self.llm.chat(messages, tools=self.tool_manager.list_schemas())

            # LLM 返回文本，任务完成
            if not response.tool_calls:
                steps.append({"type": "response", "content": response.content})
                return AgentResult(
                    success=True,
                    message=response.content,
                    state=state,
                    steps=steps,
                )

            # 执行工具调用
            for tool_call in response.tool_calls:
                result = self._execute_tool(tool_call, state)
                steps.append({
                    "type": "tool_call",
                    "tool": tool_call.name,
                    "args": tool_call.args,
                    "result": result.message,
                })

                # 把工具结果加入消息，供 LLM 决策下一步
                messages.append({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [tool_call],
                })
                messages.append({
                    "role": "tool",
                    "content": result.message,
                })

                # 如果工具失败，继续让 LLM 决策
                if not result.success:
                    continue

                # 保存最新状态
                if result.state:
                    state = result.state
                    self.store.save_canvas(state)

            # 更新用户消息中的画布状态
            messages[1] = {
                "role": "user",
                "content": self._build_user_message(prompt, state),
            }

        # 超过最大步数
        return AgentResult(
            success=True,
            message="已达到最大执行步数",
            state=state,
            steps=steps,
        )

    def _execute_tool(self, tool_call: ToolCall, state: CanvasState) -> ToolResult:
        """执行单个工具调用，处理特殊参数"""
        args = dict(tool_call.args)

        # 处理单个 node_id 特殊值
        if "node_id" in args:
            args["node_id"] = self._resolve_node_id(args["node_id"], state)
            if args["node_id"] is None:
                return ToolResult(
                    success=False,
                    message="画布上没有节点可操作",
                    state=state,
                )

        # 处理 node_ids 列表（如 compose_images）
        if "node_ids" in args:
            args["node_ids"] = self._resolve_node_ids(args["node_ids"], state)

        tool = self.tool_manager.get(tool_call.name)
        return tool.run(state, **args)

    def _resolve_node_id(self, node_id: str, state: CanvasState) -> str | None:
        """解析特殊节点 ID"""
        if node_id == "first":
            nodes = state.list_nodes()
            return nodes[0].id if nodes else None
        if node_id == "all":
            # MVP: 删除所有节点时逐个删（这里返回第一个，循环会处理）
            nodes = state.list_nodes()
            return nodes[0].id if nodes else None
        return node_id

    def _resolve_node_ids(self, node_ids: list[str], state: CanvasState) -> list[str]:
        """解析节点 ID 列表中的特殊值（first/all）"""
        resolved: list[str] = []
        for nid in node_ids:
            if nid in ("all", "first"):
                # all: 取画布上所有节点；first: 取第一个
                nodes = state.list_nodes()
                if nid == "first" and nodes:
                    resolved.append(nodes[0].id)
                else:
                    resolved.extend(n.id for n in nodes)
            else:
                resolved.append(nid)
        return resolved

    def _build_user_message(self, prompt: str, state: CanvasState) -> str:
        """构建包含画布状态的用户消息"""
        nodes_info = []
        for i, n in enumerate(state.list_nodes(), 1):
            if n.type == "image":
                nodes_info.append(
                    f"- [图{i}] {n.id}: image prompt='{n.content}' "
                    f"size={n.width}x{n.height} at ({n.x}, {n.y})"
                )
            else:
                nodes_info.append(
                    f"- [图{i}] {n.id}: {n.type} '{n.content}' at ({n.x}, {n.y})"
                )
        canvas_context = "\n".join(nodes_info) if nodes_info else "(空画布)"
        return f"画布当前节点：\n{canvas_context}\n\n用户指令：{prompt}"
