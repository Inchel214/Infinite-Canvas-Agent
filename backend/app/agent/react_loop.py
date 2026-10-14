"""ReAct Agent 循环（自研，预留 LangGraph 迁移点）

执行流程：规划+路由（纯对话 [chat] 前缀单次调用直答；工具任务产出分步计划）
→ 逐步执行（Act）→ 失败反思（Reflect）→ 汇总回复。
支持 SSE 事件回调（on_event）与外部停止（RunControl，按 canvas_id 注册，/agent/stop 触发）。
事件流（token 级打字机）：
  plan_delta（计划逐字）/ delta（思考与回复逐字）/ tool_start / tool_result /
  response（最终回复完成）/ done（收尾，带完整结果）
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable

from app.agent.llm import BaseLLM, LLMResponse, ToolCall
from app.agent.prompts import build_system_prompt
from app.canvas.state import CanvasState
from app.canvas.store import BaseStore
from app.tools.base import ToolManager, ToolResult

# 事件回调类型
EventCallback = Callable[[dict], None]

# 规划阶段附加在用户消息后的指令：工具任务给分步计划；纯对话以 [chat] 开头直接回答
PLAN_SUFFIX = (
    "\n\n请先判断这个请求，按两种方式之一处理：\n"
    "1. 若是需要调用工具的画布操作任务（生成、编辑、移动、删除图片、合并、查看节点等），"
    "请给出简要分步计划（每步一句话，最多 5 步；单步任务也请列出）。只输出计划文字本身，不要调用工具。\n"
    "2. 若是纯对话（问候、闲聊、知识问答、意见建议等），不需要操作画布，"
    "请以标记 [chat] 开头回复，直接回答用户。"
)

# 纯对话标记：规划调用返回以它开头时，跳过计划与 ReAct 循环，单次调用收尾
CHAT_PREFIX = "[chat]"

# 工具失败后注入 tool 消息的反思提示：驱动 LLM 分析原因并调整方案
REFLECTION_HINT = (
    "\n\n[系统提示] 上一步执行失败。请反思原因（参数是否正确、目标节点是否存在等），"
    "决定：调整参数重试、换一种方案、或如实告知用户无法完成。"
)


class RunControl:
    """进行中 Agent 运行的注册表：外部可按 canvas_id 请求停止（线程安全）"""

    def __init__(self):
        self._lock = threading.Lock()
        self._events: dict[str, threading.Event] = {}

    def register(self, canvas_id: str) -> threading.Event:
        """注册一次运行，返回其停止信号"""
        evt = threading.Event()
        with self._lock:
            self._events[canvas_id] = evt
        return evt

    def unregister(self, canvas_id: str, evt: threading.Event) -> None:
        """运行结束时注销（只注销自己注册的那个，避免并发运行互踩）"""
        with self._lock:
            if self._events.get(canvas_id) is evt:
                del self._events[canvas_id]

    def request_stop(self, canvas_id: str) -> bool:
        """请求停止指定画布当前运行；返回是否存在进行中的运行"""
        with self._lock:
            evt = self._events.get(canvas_id)
        if evt is None:
            return False
        evt.set()
        return True


@dataclass
class AgentResult:
    """Agent 执行结果"""
    success: bool
    message: str
    state: CanvasState
    steps: list[dict] = field(default_factory=list)
    stopped: bool = False  # 用户主动停止


class ReActAgent:
    """
    规划 + ReAct 循环：先规划 -> 思考 -> 调用工具 -> 观察结果（失败反思）-> 继续/终止

    扩展点：后续可替换为 LangGraph 实现，接口保持不变。
    """

    def __init__(
        self,
        llm: BaseLLM,
        tool_manager: ToolManager,
        store: BaseStore,
        max_steps: int = 30,
        control: RunControl | None = None,
    ):
        self.llm = llm
        self.tool_manager = tool_manager
        self.store = store
        self.max_steps = max_steps
        self.control = control or RunControl()

    def run(
        self,
        prompt: str,
        canvas_id: str,
        history: list[dict] | None = None,
        on_event: EventCallback | None = None,
    ) -> AgentResult:
        """执行 Agent 循环。

        history 为该画布的历史对话（user/assistant），注入 LLM 上下文；
        on_event 非空时逐步推送执行事件（SSE 流式）。
        """
        state = self.store.get_canvas(canvas_id)

        def emit(evt: dict) -> None:
            if on_event is not None:
                on_event(evt)

        stop_evt = self.control.register(canvas_id)
        try:
            # system + 历史对话 + 当前用户消息（当前消息每步重建画布状态）
            messages: list[dict] = [
                {"role": "system", "content": build_system_prompt()},  # 热加载风格库目录
                *(history or []),
            ]
            user_msg_index = len(messages)
            messages.append({"role": "user", "content": self._build_user_message(prompt, state)})

            steps: list[dict] = []

            # ===== 规划 + 路由阶段：一次无工具 LLM 调用 =====
            # 工具任务 → 分步计划（plan_delta 流式，注入上下文）；
            # 纯对话 → [chat] 前缀直接回答（delta 流式，单次调用收尾，不出计划卡片）
            plan, chat_answer = self._make_plan(messages, user_msg_index, emit)
            if chat_answer:
                steps.append({"type": "response", "content": chat_answer})
                emit({"type": "response", "content": chat_answer})
                return AgentResult(success=True, message=chat_answer, state=state, steps=steps)
            if plan:
                steps.append({"type": "plan", "content": plan})
                # 计划注入上下文，执行阶段模型能看到自己的计划
                messages.append({"role": "assistant", "content": f"执行计划：\n{plan}"})

            # ===== 执行阶段：ReAct 循环 =====
            for _step in range(self.max_steps):
                if stop_evt.is_set():
                    return self._stopped_result(state, steps)

                # LLM 流式调用：文本增量实时推给前端（打字机），tool_calls 聚合后照常执行
                response = self.llm.chat_stream(
                    messages,
                    tools=self.tool_manager.list_schemas(),
                    on_text=lambda s: emit({"type": "delta", "content": s}),
                )

                # LLM 返回文本，任务完成
                if not response.tool_calls:
                    steps.append({"type": "response", "content": response.content})
                    emit({"type": "response", "content": response.content})
                    return AgentResult(
                        success=True,
                        message=response.content,
                        state=state,
                        steps=steps,
                    )

                # 执行工具调用
                aborted = False
                for tool_call in response.tool_calls:
                    if stop_evt.is_set():
                        aborted = True
                        break

                    emit({"type": "tool_start", "tool": tool_call.name, "args": tool_call.args})
                    result = self._execute_tool(tool_call, state)
                    steps.append({
                        "type": "tool_call",
                        "tool": tool_call.name,
                        "args": tool_call.args,
                        "result": result.message,
                    })

                    # 工具结果加入消息，供 LLM 决策下一步；失败时附反思提示
                    tool_content = result.message
                    if not result.success:
                        tool_content += REFLECTION_HINT
                    messages.append({
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [tool_call],
                    })
                    messages.append({
                        "role": "tool",
                        "content": tool_content,
                    })

                    # 保存最新状态（成功且有新状态时）
                    canvas_dict = None
                    if result.success and result.state:
                        state = result.state
                        self.store.save_canvas(state)
                        canvas_dict = state.to_dict()

                    emit({
                        "type": "tool_result",
                        "tool": tool_call.name,
                        "result": result.message,
                        "success": result.success,
                        **({"canvas": canvas_dict} if canvas_dict else {}),
                    })

                if aborted:
                    return self._stopped_result(state, steps)

                # 更新当前用户消息中的画布状态（历史消息保持原样）
                messages[user_msg_index] = {
                    "role": "user",
                    "content": self._build_user_message(prompt, state),
                }

            # 超过最大步数：明确标记未完成（可继续对话接着执行）
            return AgentResult(
                success=False,
                message="已达到最大执行步数，任务可能未完成；可以继续发送指令让我接着执行。",
                state=state,
                steps=steps,
            )
        finally:
            self.control.unregister(canvas_id, stop_evt)

    def _make_plan(
        self,
        messages: list[dict],
        user_msg_index: int,
        emit: Callable[[dict], None],
    ) -> tuple[str, str]:
        """规划 + 路由：一次无工具 LLM 调用完成判断与输出。

        返回 (plan, chat_answer)：
        - 工具任务 → plan 非空（plan_delta 流式推送，注入执行上下文）
        - 纯对话 → 模型以 [chat] 开头直接回答，chat_answer 非空，
          调用方可跳过 ReAct 循环单次调用收尾
        失败/空结果（如 Mock 模式）时静默降级为直接执行，不阻断主流程。

        流式路由：开头几个 chunk 分不清是不是 [chat]，用小状态机——
        未定时缓冲并匹配前缀，匹配上转 delta，不匹配转 plan_delta。
        """
        plan_messages = list(messages)
        plan_messages[user_msg_index] = {
            "role": "user",
            "content": messages[user_msg_index]["content"] + PLAN_SUFFIX,
        }

        # pending（未定）→ chat（纯对话，文本进 delta）/ plan（计划，文本进 plan_delta）
        state = {"mode": "pending", "buf": ""}

        def on_text(s: str) -> None:
            mode = state["mode"]
            if mode == "chat":
                emit({"type": "delta", "content": s})
                return
            if mode == "plan":
                emit({"type": "plan_delta", "content": s})
                return
            # 未定：累积并尝试匹配 [chat] 前缀（忽略前导空白）
            buf = (state["buf"] + s).lstrip()
            state["buf"] = buf
            if not buf:
                return  # 目前只有空白，继续等
            if buf == CHAT_PREFIX:
                state["mode"] = "chat"
                return
            if CHAT_PREFIX.startswith(buf):
                return  # [chat] 的部分前缀，继续缓冲等下一片
            if buf.startswith(CHAT_PREFIX):
                # 整块到达（非流式降级路径常见）：[chat]+正文一次给出
                state["mode"] = "chat"
                rest = buf[len(CHAT_PREFIX):]
                if rest:
                    emit({"type": "delta", "content": rest})
                return
            state["mode"] = "plan"
            emit({"type": "plan_delta", "content": buf})

        try:
            resp = self.llm.chat_stream(plan_messages, tools=None, on_text=on_text)
        except Exception:
            # 规划失败不阻断执行（网络抖动 / Mock 模式等）
            return "", ""
        content = (resp.content or "").strip()
        if content.startswith(CHAT_PREFIX):
            # 纯对话：直接回答，跳过计划与主循环
            return "", content[len(CHAT_PREFIX):].strip()
        return content, ""

    @staticmethod
    def _stopped_result(state: CanvasState, steps: list[dict]) -> AgentResult:
        return AgentResult(
            success=False,
            stopped=True,
            message="已按你的要求停止执行。",
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
        """解析特殊节点 ID：first/all，以及 #N / N / 图N 编号指代"""
        if node_id == "first":
            nodes = state.list_nodes()
            return nodes[0].id if nodes else None
        if node_id == "all":
            # MVP: 删除所有节点时逐个删（这里返回第一个，循环会处理）
            nodes = state.list_nodes()
            return nodes[0].id if nodes else None
        # 用户说"3号图"时 LLM 可能传 "#3" / "3" / "图3"，按编号映射到节点 ID
        idx = self._parse_index(node_id)
        if idx is not None:
            for n in state.list_nodes():
                if n.index == idx:
                    return n.id
            return None
        return node_id

    @staticmethod
    def _parse_index(value: str) -> int | None:
        """把 '#3' / '3' / '图3' / '第3张' 解析为编号 3，其余返回 None"""
        import re

        m = re.fullmatch(r"#?(\d+)|图#?(\d+)|第(\d+)[张个]?", str(value).strip())
        if not m:
            return None
        num = next(g for g in m.groups() if g is not None)
        return int(num)

    def _resolve_node_ids(self, node_ids: list[str], state: CanvasState) -> list[str]:
        """解析节点 ID 列表中的特殊值（first/all）与编号指代（#N / 图N）"""
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
                rid = self._resolve_node_id(nid, state)
                if rid is not None:
                    resolved.append(rid)
        return resolved

    def _build_user_message(self, prompt: str, state: CanvasState) -> str:
        """构建包含画布状态的用户消息"""
        nodes_info = []
        for n in state.list_nodes():
            label = f"图{n.index}" if n.index is not None else "图?"
            if n.type == "image":
                nodes_info.append(
                    f"- [{label}] {n.id}: image prompt='{n.content}' "
                    f"size={n.width}x{n.height} at ({n.x}, {n.y})"
                )
            else:
                nodes_info.append(
                    f"- [{label}] {n.id}: {n.type} '{n.content}' at ({n.x}, {n.y})"
                )
        canvas_context = "\n".join(nodes_info) if nodes_info else "(空画布)"
        return f"画布当前节点：\n{canvas_context}\n\n用户指令：{prompt}"
