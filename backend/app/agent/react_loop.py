"""ReAct Agent 循环（自研，预留 LangGraph 迁移点）

执行流程：规划+路由（纯对话 [chat] 前缀单次调用直答；工具任务产出分步计划）
→ 逐步执行（Act）→ 失败反思（Reflect）→ 汇总回复。
支持 SSE 事件回调（on_event）与外部停止（RunControl，按 canvas_id 注册，/agent/stop 触发）。
事件流（token 级打字机）：
  plan_delta（计划逐字）/ delta（思考与回复逐字）/ tool_start / tool_result /
  response（最终回复完成）/ done（收尾，带完整结果）

并行执行：当 LLM 一次返回多个生图类工具调用时，自动并行执行（耗时最长，收益最大）。
生图工具（generate/variate/edit/compose）都是"创建新节点"，天然无依赖，可安全并行。
"""
from __future__ import annotations

import copy
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Callable

from app.agent.llm import BaseLLM, LLMResponse, ToolCall
from app.agent.prompts import build_system_prompt
from app.agent.sessions import clean_profile_output
from app.canvas.state import CanvasState
from app.canvas.store import BaseStore
from app.tools.base import ToolManager, ToolResult

# 生图类工具：耗时最长（10-30秒），可并行执行
IMAGE_TOOLS = {"generate_image", "variate_image", "edit_image", "compose_images"}

logger = logging.getLogger(__name__)


def _clip(text: object, n: int) -> str:
    """日志友好化：单行 + 截断，避免大段 prompt/base64 污染日志"""
    s = str(text or "").replace("\n", " ").strip()
    return s if len(s) <= n else s[:n] + "…"


def _clip_args(args: dict, n: int = 160) -> str:
    try:
        import json as _json
        return _clip(_json.dumps(args, ensure_ascii=False), n)
    except Exception:
        return _clip(args, n)

# 事件回调类型
EventCallback = Callable[[dict], None]

# 规划阶段附加在用户消息后的指令：先明确路由，再由主循环决定展示与执行方式
PLAN_SUFFIX = (
    "\n\n请先判断这个请求，严格按三种方式之一处理：\n"
    "1. 可直接执行的画布操作任务（生成、编辑、移动、删除图片、合并、查看节点等）："
    "给出简要分步计划（每步一句话，最多 5 步；单步任务也请列出）。只输出计划文字本身，不要调用工具。\n"
    "2. 纯对话（问候、闲聊、知识问答、意见建议等），不需要操作画布："
    "以标记 [chat] 开头，直接回答用户。\n"
    "3. 缺少关键信息、必须让用户选择或确认后才能安全执行："
    "以标记 [clarify] 开头，紧随其后只输出一个 JSON 对象，格式为 "
    '{"question":"要问用户的问题","options":["选项1","选项2"],'
    '"default_action":"取消本次操作","timeout":300}。'
    "options 只在存在明确候选时提供；不要用正文提问，不要同时输出执行计划。"
)

# 纯对话 / 阻塞式澄清标记：路由确定前不向 frontend 发送计划事件，避免误显示计划卡
CHAT_PREFIX = "[chat]"
CLARIFY_PREFIX = "[clarify]"

# 工具失败后注入 tool 消息的反思提示：驱动 LLM 分析原因并调整方案
REFLECTION_HINT = (
    "\n\n[系统提示] 上一步执行失败。请反思原因（参数是否正确、目标节点是否存在等），"
    "决定：调整参数重试、换一种方案、或如实告知用户无法完成。"
)


class _ClarifyStreamGuard:
    """执行阶段流式预检：若 LLM 输出以 [clarify] 开头，拦截 delta 不推前端。

    规划阶段的 [clarify] 识别只挂在 _make_plan；执行阶段 LLM 若沿用文本标记
    模式澄清，未拦截时 "[clarify]{...}" 原文会随打字机 delta 推到前端。
    非 clarify 的正常回复在可判定前缀后立即放行，首字符非 '[' 时零延迟。
    """

    def __init__(self, downstream: Callable[[str], None]):
        self._downstream = downstream
        self._buffer = ""
        self._decided = False
        self.suppressed = False

    def feed(self, text: str) -> None:
        if self.suppressed:
            return
        if self._decided:
            self._downstream(text)
            return
        self._buffer += text
        stripped = self._buffer.lstrip()
        # 前缀尚未完整且仍有可能匹配 [clarify]：继续缓冲等待判定
        if len(stripped) < len(CLARIFY_PREFIX) and CLARIFY_PREFIX.startswith(stripped):
            return
        self._decided = True
        if stripped.startswith(CLARIFY_PREFIX):
            self.suppressed = True
            self._buffer = ""
            return
        buffered, self._buffer = self._buffer, ""
        self._downstream(buffered)


class _ProfileStreamFilter:
    """流式隐藏内部 profile_delta；保留短尾部避免跨 chunk 标记泄漏。"""

    def __init__(self, emit: EventCallback):
        self.emit = emit
        self.buffer = ""

    def feed(self, text: str) -> None:
        self.buffer += text
        if "</profile_delta>" in self.buffer:
            clean, _ = clean_profile_output(self.buffer)
            self.buffer = ""
            if clean:
                self.emit({"type": "delta", "content": clean})
            return
        if "<profile_delta>" in self.buffer or "```" in self.buffer:
            return
        # 标记可能分片到达，尾部最多保留 32 字。
        if len(self.buffer) > 32:
            visible, self.buffer = self.buffer[:-32], self.buffer[-32:]
            self.emit({"type": "delta", "content": visible})

    def finish(self) -> str:
        clean, _ = clean_profile_output(self.buffer)
        self.buffer = ""
        if clean:
            self.emit({"type": "delta", "content": clean})
        return clean


class RunControl:
    """进行中 Agent 运行的注册表：外部可按 canvas_id 请求停止或暂停等待用户回复（线程安全）"""

    def __init__(self):
        self._lock = threading.Lock()
        self._events: dict[str, threading.Event] = {}  # 停止信号
        self._pause_events: dict[str, threading.Event] = {}  # 暂停信号（用户回复后 set）
        self._pending_questions: dict[str, dict] = {}  # 等待中的问题
        self._user_responses: dict[str, str] = {}  # 用户回复
        self._last_activity: dict[str, float] = {}  # 最近一次用户操作（monotonic 时间）

    def register(self, canvas_id: str) -> threading.Event:
        """注册一次运行，返回其停止信号"""
        evt = threading.Event()
        pause_evt = threading.Event()
        pause_evt.set()  # 初始为 set，不暂停
        with self._lock:
            self._events[canvas_id] = evt
            self._pause_events[canvas_id] = pause_evt
        return evt

    def unregister(self, canvas_id: str, evt: threading.Event) -> None:
        """运行结束时注销（只注销自己注册的那个，避免并发运行互踩）"""
        with self._lock:
            if self._events.get(canvas_id) is evt:
                del self._events[canvas_id]
                self._pause_events.pop(canvas_id, None)
                self._pending_questions.pop(canvas_id, None)
                self._user_responses.pop(canvas_id, None)
                self._last_activity.pop(canvas_id, None)

    def request_stop(self, canvas_id: str) -> bool:
        """请求停止指定画布当前运行；返回是否存在进行中的运行"""
        with self._lock:
            evt = self._events.get(canvas_id)
        if evt is None:
            return False
        evt.set()
        # 同时唤醒暂停等待，让线程能退出
        with self._lock:
            pause_evt = self._pause_events.get(canvas_id)
        if pause_evt:
            pause_evt.set()
        return True

    def request_pause(self, canvas_id: str, question: dict) -> bool:
        """请求暂停并等待用户回复。返回是否成功暂停。"""
        with self._lock:
            pause_evt = self._pause_events.get(canvas_id)
            stop_evt = self._events.get(canvas_id)
            if not pause_evt or (stop_evt and stop_evt.is_set()):
                return False
            self._pending_questions[canvas_id] = question
            self._last_activity[canvas_id] = time.monotonic()
            pause_evt.clear()  # 清空，等待用户回复后 set
        logger.debug("[RunControl] 请求暂停 canvas=%s question=%s", canvas_id, question.get("question", "")[:50])
        return True

    def wait_for_response(self, canvas_id: str, timeout: int = 300) -> str | None:
        """阻塞等待用户回复；用户活动时重新计算空闲超时。"""
        with self._lock:
            pause_evt = self._pause_events.get(canvas_id)
            stop_evt = self._events.get(canvas_id)
            self._last_activity[canvas_id] = time.monotonic()
        if not pause_evt:
            return None

        while True:
            with self._lock:
                last_activity = self._last_activity.get(canvas_id, time.monotonic())
            remaining = timeout - (time.monotonic() - last_activity)
            if remaining <= 0:
                logger.debug("[RunControl] 用户连续无操作超时 canvas=%s", canvas_id)
                return None

            if pause_evt.wait(timeout=remaining):
                # 检查是否是被停止唤醒的
                if stop_evt and stop_evt.is_set():
                    return None
                with self._lock:
                    response = self._user_responses.pop(canvas_id, None)
                logger.debug("[RunControl] 收到用户回复 canvas=%s response=%s", canvas_id, (response or "")[:50])
                return response
            # 等待到期后重新读取活动时间；期间有输入则进入下一轮，而不是直接超时。

    def record_activity(self, canvas_id: str) -> bool:
        """记录用户在询问卡上的操作；仅等待回复时有效。"""
        with self._lock:
            pause_evt = self._pause_events.get(canvas_id)
            if not pause_evt or pause_evt.is_set():
                return False
            self._last_activity[canvas_id] = time.monotonic()
            return True

    def provide_response(self, canvas_id: str, response: str) -> bool:
        """用户提供回复，恢复执行"""
        with self._lock:
            pause_evt = self._pause_events.get(canvas_id)
            if pause_evt and not pause_evt.is_set():
                self._user_responses[canvas_id] = response
                pause_evt.set()  # 唤醒等待的线程
                logger.debug("[RunControl] 用户回复恢复执行 canvas=%s", canvas_id)
                return True
        return False

    def get_pending_question(self, canvas_id: str) -> dict | None:
        """获取当前等待中的问题"""
        with self._lock:
            return self._pending_questions.get(canvas_id)


@dataclass
class AgentResult:
    """Agent 执行结果"""
    success: bool
    message: str
    state: CanvasState
    steps: list[dict] = field(default_factory=list)
    stopped: bool = False  # 用户主动停止
    waiting_for_user: bool = False  # 等待用户回复
    pending_question: dict | None = None  # 等待中的问题
    run_id: str | None = None  # 本轮执行记录 ID（持久化 assistant 消息关联用）


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
        max_steps: int = 100,
        control: RunControl | None = None,
        chat_sessions: "ChatSessionStore | None" = None,  # 工具步骤实时持久化
        feedback=None,
    ):
        self.llm = llm
        self.tool_manager = tool_manager
        self.store = store
        self.max_steps = max_steps
        self.control = control or RunControl()
        self.chat_sessions = chat_sessions
        self.feedback = feedback

    def run(
        self,
        prompt: str,
        canvas_id: str,
        history: list[dict] | None = None,
        on_event: EventCallback | None = None,
        failure_note: str | None = None,
        referenced_images: list[dict] | None = None,  # Vision: 用户引用的图片列表
        steer_provider: Callable[[], dict | None] | None = None,  # 工具边界注入排队消息（steering）
        round_id: str | None = None,
    ) -> AgentResult:
        """执行 Agent 循环。

        history 为该画布的历史对话（user/assistant），注入 LLM 上下文；
        failure_note 为上一轮未完成任务的摘要（供"重试/继续"精确重放）；
        on_event 非空时逐步推送执行事件（SSE 流式）；
        referenced_images 为用户引用的图片列表（Vision 能力）；
        steer_provider 非空时，每个 ReAct 步骤的 LLM 调用前调用一次，
        若返回排队消息（{"prompt", "referenced_images"}）则注入对话（steering），
        Agent 在同一回合内即可响应新指令。
        """
        state = self.store.get_canvas(canvas_id)

        def emit(evt: dict) -> None:
            if on_event is not None:
                on_event(evt)

        stop_evt = self.control.register(canvas_id)
        feedback_round_id = round_id or ""
        # 工具步骤实时持久化：创建 run 记录
        run_id = None
        if self.chat_sessions:
            run_id = self.chat_sessions.begin_run(canvas_id, prompt, round_id=round_id)

        def add_timeline(segment: dict) -> None:
            """追加一个时间线段（plan/text/tool/user），供前端按时间线还原执行过程"""
            if self.chat_sessions and run_id:
                self.chat_sessions.append_timeline_segment(canvas_id, run_id, segment)

        def tool_meta(result: ToolResult) -> dict:
            """工具结果中前端展示/定位所需的数据（如新建节点的 node_id 与图片地址）"""
            return {"data": result.data} if result.data else {}

        try:
            # system + 历史对话 + 当前用户消息（当前消息每步重建画布状态）
            system_prompt = build_system_prompt()
            messages: list[dict] = [
                {"role": "system", "content": system_prompt},
                *(history or []),
            ]
            user_msg_index = len(messages)
            messages.append({
                "role": "user",
                "content": self._build_user_message(prompt, state, failure_note, referenced_images),
            })

            logger.info(
                "[Agent] 任务开始 canvas=%s prompt=%s",
                canvas_id, _clip(prompt, 80),
            )
            logger.debug(
                "[Agent] 上下文组装 canvas=%s | system_prompt=%d字 | history=%d条 | "
                "failure_note=%s | referenced_images=%d",
                canvas_id, len(system_prompt), len(history or []),
                "有" if failure_note else "无",
                len(referenced_images) if referenced_images else 0,
            )
            logger.debug("[Agent] System Prompt 全文:\n%s", system_prompt)

            steps: list[dict] = []

            # ===== 规划 + 路由阶段：一次无工具 LLM 调用 =====
            # execute → 分类完成后再发计划；chat → 直接回复；
            # clarify → 合成一次真实 ask_user 工具调用，复用暂停/回复/续跑链路。
            plan, chat_answer, clarification = self._make_plan(messages, user_msg_index, emit)
            if chat_answer:
                logger.debug("[Agent] 路由决策: 纯对话（chat），跳过 ReAct 循环")
                if self.chat_sessions and run_id:
                    chat_answer = self.chat_sessions.finish_run(
                        canvas_id, run_id, "done", chat_answer
                    )
                else:
                    chat_answer, _ = clean_profile_output(chat_answer)
                steps.append({"type": "response", "content": chat_answer})
                emit({"type": "response", "content": chat_answer})
                return AgentResult(success=True, message=chat_answer, state=state, steps=steps, run_id=run_id)

            pending_tool_call: ToolCall | None = None
            if clarification:
                pending_tool_call = ToolCall(name="ask_user", args=clarification)
                messages.append({
                    "role": "assistant",
                    "content": f"我需要先向用户确认：{clarification['question']}",
                })
                logger.info(
                    "[Agent] 路由决策: 阻塞式澄清（clarify），暂停等待用户 canvas=%s question=%s",
                    canvas_id, _clip(clarification["question"], 120),
                )
            elif plan:
                logger.debug("[Agent] 路由决策: 工具任务（execute），进入 ReAct 循环")
                steps.append({"type": "plan", "content": plan})
                if self.chat_sessions and run_id:
                    self.chat_sessions.update_run_plan(canvas_id, run_id, plan)
                add_timeline({"kind": "plan", "text": plan})
                messages.append({"role": "assistant", "content": f"执行计划：\n{plan}"})
                logger.info("[Agent] 计划已生成 canvas=%s plan=%s", canvas_id, _clip(plan, 120))

            # ===== 执行阶段：ReAct 循环 =====
            for _step in range(self.max_steps):
                if stop_evt.is_set():
                    # 完成 run 记录
                    if self.chat_sessions and run_id:
                        self.chat_sessions.finish_run(canvas_id, run_id, "stopped", "")
                    return self._stopped_result(state, steps, run_id)

                logger.debug(
                    "[Agent] ReAct 步骤 %d/%d canvas=%s | 消息数=%d",
                    _step + 1, self.max_steps, canvas_id, len(messages),
                )

                # 工具边界注入（steering）：LLM 调用前检查排队消息，
                # 有则注入本轮对话，Agent 同一回合内即可看到并响应新指令
                if steer_provider is not None:
                    steered = steer_provider()
                    if steered and steered.get("prompt"):
                        steer_prompt = steered["prompt"]
                        feedback_round_id = steered.get("round_id") or feedback_round_id
                        logger.info(
                            "[Agent] steering 注入排队消息 canvas=%s prompt=%s",
                            canvas_id, _clip(steer_prompt, 80),
                        )
                        emit({"type": "user_message", "content": steer_prompt})
                        messages.append({
                            "role": "user",
                            "content": self._build_user_message(
                                steer_prompt, state, None,
                                steered.get("referenced_images"),
                            ),
                        })
                        user_msg_index = len(messages) - 1
                        add_timeline({"kind": "user", "text": steer_prompt})
                        if self.chat_sessions and run_id:
                            self.chat_sessions.mark_user_steered(
                                canvas_id, steer_prompt, run_id
                            )

                # LLM 流式调用：深度思考过程实时推前端（reasoning_delta），
                # 文本增量实时推前端（delta 打字机），tool_calls 聚合后照常执行。
                # 执行阶段保留深度思考，复杂工具链的规划质量靠它。
                _text_filter = _ProfileStreamFilter(emit)
                _clarify_guard = _ClarifyStreamGuard(_text_filter.feed)
                def _on_text(s: str) -> None:
                    _clarify_guard.feed(s)

                if pending_tool_call is not None:
                    # 规划阶段已明确需要澄清：第一步不请求 LLM，直接走标准 ask_user 工具分支。
                    response = LLMResponse(content="", tool_calls=[pending_tool_call])
                    pending_tool_call = None
                else:
                    response = self.llm.chat_stream(
                        messages,
                        tools=self.tool_manager.list_schemas(),
                        on_text=_on_text,
                        on_reasoning=lambda s: emit({"type": "reasoning_delta", "content": s}),
                    )

                _text_filter.finish()
                # LLM 返回文本，任务完成
                if not response.tool_calls:
                    # 执行阶段二次澄清兜底：[clarify] 识别原先只挂在规划阶段
                    # （_make_plan），执行中沿用文本标记的澄清会被当最终回复，
                    # 表现为"第二次提问退化成纯文字、run 直接结束"。这里统一
                    # 转成 ask_user 工具调用，同一 run 内可多次澄清。
                    clarify_payload = self._normalize_clarify_payload(response.content)
                    if clarify_payload is not None:
                        pending_tool_call = ToolCall(name="ask_user", args=clarify_payload)
                        messages.append({
                            "role": "assistant",
                            "content": f"我需要先向用户确认：{clarify_payload['question']}",
                        })
                        logger.info(
                            "[Agent] 执行阶段澄清（clarify 兜底），暂停等待用户 canvas=%s question=%s",
                            canvas_id, _clip(clarify_payload["question"], 120),
                        )
                        continue
                    clean_content, _ = clean_profile_output(response.content)
                    if self.chat_sessions and run_id:
                        clean_content = self.chat_sessions.finish_run(
                            canvas_id, run_id, "done", response.content
                        )
                    steps.append({"type": "response", "content": clean_content})
                    emit({"type": "response", "content": clean_content})
                    logger.info(
                        "[Agent] 任务完成 canvas=%s 步数=%d 回复=%s",
                        canvas_id, _step + 1, _clip(clean_content, 120),
                    )
                    return AgentResult(
                        success=True,
                        message=clean_content,
                        state=state,
                        steps=steps,
                        run_id=run_id,
                    )

                # 中间说明文本 flush 到 timeline：工具卡片前的过程文本，
                # 前端据此把"文本→工具→文本"按时间线完整还原
                intermediate_text, _ = clean_profile_output(response.content)
                if intermediate_text:
                    add_timeline({"kind": "text", "text": intermediate_text})

                # 执行工具调用（支持并行执行生图工具）
                aborted = False
                
                # 分离生图工具和其他工具
                image_tool_calls = [tc for tc in response.tool_calls if tc.name in IMAGE_TOOLS]
                other_tool_calls = [tc for tc in response.tool_calls if tc.name not in IMAGE_TOOLS]
                
                # 并行执行生图工具（如果有多个）
                if len(image_tool_calls) > 1:
                    logger.info(
                        "[Tool] 并行执行 %d 个生图工具 canvas=%s",
                        len(image_tool_calls), canvas_id,
                    )
                    # 编号统一管理：派发前从主画布一次性预留号段，各副本以此起步。
                    # 否则副本各自从相同的 next_index 自增，会抢注到同一个编号。
                    reserved_indices = state.reserve_indices(len(image_tool_calls))
                    state_copies: dict[int, CanvasState] = {}
                    for i, tc in enumerate(image_tool_calls):
                        state_copy = copy.deepcopy(state)
                        state_copy.next_index = reserved_indices[i]
                        state_copies[i] = state_copy

                    # 必须先推 tool_start：前端靠它清空本轮的中间说明文本，
                    # 否则并行生图时多轮 delta 会累加到同一个气泡里（表现为大量重复句子）
                    for tool_call in image_tool_calls:
                        emit({"type": "tool_start", "tool": tool_call.name, "args": tool_call.args})

                    def execute_image_tool(idx: int, tool_call: ToolCall, tool_state: CanvasState) -> tuple[int, ToolResult, float]:
                        """执行单个生图工具，返回 (index, result, cost_ms)"""
                        _t0 = time.monotonic()
                        result = self._execute_tool(
                            tool_call, tool_state, round_id=feedback_round_id
                        )
                        _cost_ms = int((time.monotonic() - _t0) * 1000)
                        return idx, result, _cost_ms

                    # 使用线程池并行执行
                    with ThreadPoolExecutor(max_workers=min(len(image_tool_calls), 4)) as executor:
                        futures = {
                            executor.submit(execute_image_tool, i, tc, state_copies[i]): i
                            for i, tc in enumerate(image_tool_calls)
                        }

                        # 收集结果（按原始顺序）
                        results_map: dict[int, tuple[ToolResult, float]] = {}
                        for future in as_completed(futures):
                            idx, result, cost_ms = future.result()
                            results_map[idx] = (result, cost_ms)

                    # 按原始顺序处理结果
                    for i, tool_call in enumerate(image_tool_calls):
                        if stop_evt.is_set():
                            aborted = True
                            break

                        result, cost_ms = results_map[i]

                        if result.success:
                            logger.info(
                                "[Tool] 完成 %s canvas=%s 耗时=%dms 结果=%s",
                                tool_call.name, canvas_id, cost_ms, _clip(result.message, 120),
                            )
                        else:
                            logger.warning(
                                "[Tool] 失败 %s canvas=%s 耗时=%dms 原因=%s",
                                tool_call.name, canvas_id, cost_ms, _clip(result.message, 160),
                            )

                        steps.append({
                            "type": "tool_call",
                            "tool": tool_call.name,
                            "args": tool_call.args,
                            "result": result.message,
                            "success": result.success,
                        })
                        # 实时持久化工具步骤
                        if self.chat_sessions and run_id:
                            self.chat_sessions.append_step(canvas_id, run_id, {
                                "tool": tool_call.name,
                                "args": tool_call.args,
                                "result": result.message,
                                "success": result.success,
                            })
                        add_timeline({
                            "kind": "tool",
                            "tool": tool_call.name,
                            "args": tool_call.args,
                            "result": result.message,
                            "success": result.success,
                            **tool_meta(result),
                        })

                        # 工具结果加入消息
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

                        # 合并结果到主 state
                        if result.success and result.state:
                            # 将新节点从工具结果合并到主 state
                            for node_id, node in result.state.nodes.items():
                                if node_id not in state.nodes:
                                    state.nodes[node_id] = node
                            self.store.save_canvas(state)
                        
                        emit({
                            "type": "tool_result",
                            "tool": tool_call.name,
                            "result": result.message,
                            "success": result.success,
                            "canvas": state.to_dict() if result.success else None,
                            **tool_meta(result),
                        })
                
                # 单个生图工具走串行路径（并行分支只处理 >1 的情况，
                # 不补这里会直接漏执行）
                if len(image_tool_calls) <= 1:
                    other_tool_calls = image_tool_calls + other_tool_calls

                # 串行执行其他工具
                for tool_call in other_tool_calls:
                    if stop_evt.is_set():
                        aborted = True
                        break

                    # ask_user 工具特殊处理：推送 ask_user 事件供前端渲染
                    if tool_call.name == "ask_user":
                        emit({
                            "type": "ask_user",
                            "question": tool_call.args.get("question", ""),
                            "options": tool_call.args.get("options", []),
                            "default_action": tool_call.args.get("default_action", ""),
                            "timeout": tool_call.args.get("timeout", 300),
                        })

                    emit({"type": "tool_start", "tool": tool_call.name, "args": tool_call.args})
                    logger.info(
                        "[Tool] 开始 %s canvas=%s args=%s",
                        tool_call.name, canvas_id, _clip_args(tool_call.args),
                    )
                    logger.debug(
                        "[Tool] 完整参数 %s canvas=%s args=%s",
                        tool_call.name, canvas_id, tool_call.args,
                    )
                    _t0 = time.monotonic()
                    result = self._execute_tool(
                        tool_call, state, round_id=feedback_round_id
                    )
                    _cost_ms = int((time.monotonic() - _t0) * 1000)
                    if result.success:
                        logger.info(
                            "[Tool] 完成 %s canvas=%s 耗时=%dms 结果=%s",
                            tool_call.name, canvas_id, _cost_ms, _clip(result.message, 120),
                        )
                    else:
                        logger.warning(
                            "[Tool] 失败 %s canvas=%s 耗时=%dms 原因=%s",
                            tool_call.name, canvas_id, _cost_ms, _clip(result.message, 160),
                        )
                    steps.append({
                        "type": "tool_call",
                        "tool": tool_call.name,
                        "args": tool_call.args,
                        "result": result.message,
                        "success": result.success,
                    })
                    # 实时持久化工具步骤
                    if self.chat_sessions and run_id:
                        self.chat_sessions.append_step(canvas_id, run_id, {
                            "tool": tool_call.name,
                            "args": tool_call.args,
                            "result": result.message,
                            "success": result.success,
                        })
                    add_timeline({
                        "kind": "tool",
                        "tool": tool_call.name,
                        "args": tool_call.args,
                        "result": result.message,
                        "success": result.success,
                        **tool_meta(result),
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
                        **tool_meta(result),
                    })

                if aborted:
                    # 完成 run 记录
                    if self.chat_sessions and run_id:
                        self.chat_sessions.finish_run(canvas_id, run_id, "stopped", "")
                    return self._stopped_result(state, steps, run_id)

                # 更新当前用户消息中的画布状态（历史消息保持原样）
                messages[user_msg_index] = {
                    "role": "user",
                    "content": self._build_user_message(prompt, state, failure_note),
                }

            # 超过最大步数：标记成功（执行过程无错误）
            # 消息不提"上限/步数"等技术概念，避免 LLM 在下一轮被历史锚定后只会复述"已到上限"
            max_steps_msg = "这一轮操作已经执行完毕。如果还有未完成的部分，请告诉我接下来要做什么，我继续帮你处理。"
            # 完成 run 记录
            if self.chat_sessions and run_id:
                self.chat_sessions.finish_run(canvas_id, run_id, "done", max_steps_msg)
            return AgentResult(
                success=True,
                message=max_steps_msg,
                state=state,
                steps=steps,
                run_id=run_id,
            )
        finally:
            self.control.unregister(canvas_id, stop_evt)

    def _normalize_clarify_payload(self, content: str) -> dict | None:
        """仅把带 [clarify] 前缀的执行阶段回复转换为询问参数。"""
        stripped = content.strip()
        if not stripped.startswith(CLARIFY_PREFIX):
            return None
        return self._parse_clarification(stripped[len(CLARIFY_PREFIX):])

    @staticmethod
    def _parse_clarification(payload: str) -> dict:
        """解析 [clarify] 后的 JSON；格式异常时仍安全降级为自由输入询问。"""
        raw = payload.strip()
        if raw.startswith("```"):
            lines = raw.splitlines()
            lines = lines[1:]  # 去掉 ```json / ```
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            raw = "\n".join(lines).strip()

        data: dict = {}
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                data = parsed
        except (json.JSONDecodeError, TypeError):
            pass

        question = str(data.get("question") or "").strip()
        if not question and raw and not raw.startswith("{"):
            question = raw
        if not question:
            question = "请确认希望我如何继续？"

        options = [
            str(option).strip()
            for option in data.get("options", [])
            if str(option).strip()
        ][:6] if isinstance(data.get("options", []), list) else []
        try:
            timeout = int(data.get("timeout", 300))
        except (TypeError, ValueError):
            timeout = 300
        return {
            "question": question,
            "options": options,
            "default_action": str(data.get("default_action") or "取消本次操作"),
            "timeout": timeout,
        }

    def _make_plan(
        self,
        messages: list[dict],
        user_msg_index: int,
        emit: Callable[[dict], None],
    ) -> tuple[str, str, dict | None]:
        """一次无工具 LLM 调用完成 execute / chat / clarify 路由。

        返回 (plan, chat_answer, clarification)，三者至多一个非空。
        计划与澄清在完整分类前不外发，杜绝 inquiry 被先渲染成计划卡、又作为正文重复。
        chat 仍在识别 [chat] 前缀后流式输出；execute 计划分类完成后一次性推送。
        失败/空结果（如 Mock 模式）时降级为直接执行，不阻断主流程。
        """
        plan_messages = list(messages)
        # 处理多模态消息：content 可能是 str 或 list
        user_content = messages[user_msg_index]["content"]
        if isinstance(user_content, list):
            # 多模态格式：找到文本部分并追加 PLAN_SUFFIX
            new_content = []
            for part in user_content:
                if part.get("type") == "text":
                    # 在文本部分追加 PLAN_SUFFIX
                    new_content.append({
                        "type": "text",
                        "text": part["text"] + PLAN_SUFFIX
                    })
                else:
                    # 图片部分保持不变
                    new_content.append(part)
            plan_messages[user_msg_index] = {
                "role": "user",
                "content": new_content,
            }
        else:
            # 纯文本格式
            plan_messages[user_msg_index] = {
                "role": "user",
                "content": user_content + PLAN_SUFFIX,
            }

        # 只给确定是 chat 的内容流式外发；plan/clarify 等完整响应分类后再处理。
        route_state = {"mode": "pending", "buf": ""}
        chat_filter = _ProfileStreamFilter(emit)

        def on_text(s: str) -> None:
            if route_state["mode"] == "chat":
                chat_filter.feed(s)
                return
            if route_state["mode"] != "pending":
                return

            buf = (route_state["buf"] + s).lstrip()
            route_state["buf"] = buf
            if not buf:
                return
            if buf.startswith(CHAT_PREFIX):
                route_state["mode"] = "chat"
                rest = buf[len(CHAT_PREFIX):]
                if rest:
                    chat_filter.feed(rest)
                return
            if buf.startswith(CLARIFY_PREFIX):
                route_state["mode"] = "clarify"
                return
            if CHAT_PREFIX.startswith(buf) or CLARIFY_PREFIX.startswith(buf):
                return  # 前缀尚未完整，继续缓冲
            route_state["mode"] = "execute"

        try:
            # 规划/路由阶段关闭深度思考：闲聊与列计划都是轻量任务，
            # 关掉后首字毫秒级（思考模型默认会为一句话也思考十几秒）
            resp = self.llm.chat_stream(
                plan_messages, tools=None, on_text=on_text, thinking=False)
        except Exception:
            # 规划失败不阻断执行（网络抖动 / Mock 模式等）
            logger.warning("Agent 规划阶段失败，降级为无计划执行", exc_info=True)
            return "", "", None
        if route_state["mode"] == "chat":
            chat_filter.finish()
        content = (resp.content or "").strip()
        logger.debug("[Agent] 规划结果 content=%s", _clip(content, 200))
        if content.startswith(CHAT_PREFIX):
            return "", content[len(CHAT_PREFIX):].strip(), None
        if content.startswith(CLARIFY_PREFIX):
            clarification = self._parse_clarification(content[len(CLARIFY_PREFIX):])
            return "", "", clarification
        if content:
            # 路由已经确定为 execute，此时才允许创建计划卡。
            emit({"type": "plan_delta", "content": content})
        return content, "", None

    @staticmethod
    def _stopped_result(state: CanvasState, steps: list[dict], run_id: str | None = None) -> AgentResult:
        return AgentResult(
            success=False,
            stopped=True,
            message="已按你的要求停止执行。",
            state=state,
            steps=steps,
            run_id=run_id,
        )

    def _execute_tool(
        self, tool_call: ToolCall, state: CanvasState, round_id: str = ""
    ) -> ToolResult:
        """执行单个工具调用，处理特殊参数并记录图片行为反馈。"""
        args = dict(tool_call.args)

        # 处理单个 node_id 特殊值
        if "node_id" in args:
            resolved = self._resolve_node_id(args["node_id"], state)
            if resolved is None:
                logger.debug(
                    "[Tool] node_id 解析失败: %r → None（画布无可用节点）",
                    tool_call.args["node_id"],
                )
            elif resolved != args["node_id"]:
                logger.debug(
                    "[Tool] node_id 解析: %r → %s",
                    tool_call.args["node_id"], resolved,
                )
            args["node_id"] = resolved
            if args["node_id"] is None:
                return ToolResult(
                    success=False,
                    message="画布上没有节点可操作",
                    state=state,
                )

        # 处理 node_ids 列表（如 compose_images）
        if "node_ids" in args:
            args["node_ids"] = self._resolve_node_ids(args["node_ids"], state)

        source = state.get_node(args.get("node_id", ""))
        source_snapshot = source.to_dict() if source else None
        if tool_call.name == "save_memory" and round_id:
            args["source_round"] = round_id

        tool = self.tool_manager.get(tool_call.name)
        result = tool.run(state, **args)
        if result.success:
            self._record_tool_feedback(
                tool_call.name, state.canvas_id, source_snapshot, result, round_id
            )
        return result

    def _record_tool_feedback(
        self,
        tool_name: str,
        canvas_id: str,
        source: dict | None,
        result: ToolResult,
        round_id: str,
    ) -> None:
        if not self.feedback:
            return
        try:
            source_outcome = {
                "delete_node": "deleted",
                "variate_image": "retried",
                "edit_image": "edited",
            }.get(tool_name)
            if source_outcome and source and source.get("type") == "image":
                self.feedback.record(
                    canvas_id, node=source, outcome=source_outcome, round_id=round_id
                )
            if tool_name in IMAGE_TOOLS:
                node_id = (result.data or {}).get("node_id")
                node = result.state.get_node(node_id) if result.state and node_id else None
                if node and node.type == "image":
                    self.feedback.record(
                        canvas_id, node=node.to_dict(), outcome="kept", round_id=round_id
                    )
        except Exception:
            # 行为反馈只用于后续检索，不能反向阻断已完成的画布操作。
            logger.warning("图片行为反馈写入失败（已忽略）", exc_info=True)

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

    def _build_user_message(
        self,
        prompt: str,
        state: CanvasState,
        failure_note: str | None = None,
        referenced_images: list[dict] | None = None,
    ) -> str | list[dict]:
        """构建包含画布状态的用户消息；failure_note 附在末尾供失败任务重放。
        
        如果有 referenced_images（Vision 能力），返回多模态格式（list of content parts）；
        否则返回纯文本格式（str）。
        """
        # 构建画布上下文文本
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
        profile_text = ""
        if self.chat_sessions:
            profile = self.chat_sessions.get_profile(state.canvas_id)
            if any(profile.values()):
                profile_text = "项目档案（跨轮延续，仅在本轮有新增信息时更新）：\n" + json.dumps(
                    profile, ensure_ascii=False
                ) + "\n\n"
        text_content = f"{profile_text}画布当前节点：\n{canvas_context}\n\n用户指令：{prompt}"
        if failure_note:
            text_content += f"\n\n{failure_note}"

        # 如果没有引用图片，返回纯文本
        if not referenced_images:
            return text_content

        # 有引用图片，构建多模态消息格式
        from app.image.files import is_local_image_url

        content_parts = [{"type": "text", "text": text_content}]
        
        # 添加引用图片
        for ref in referenced_images:
            image_url = ref.get("image_url", "")
            if not image_url:
                continue
            
            # 本地图片 URL 转为压缩后的 data URL（base64）
            # 使用压缩版本避免 413 请求过大（DeepSeek 等 API 有大小限制）
            if is_local_image_url(image_url):
                try:
                    from app.image.files import local_url_to_compressed_data_url
                    data_url = local_url_to_compressed_data_url(image_url, max_size=1024, quality=80)
                    content_parts.append({
                        "type": "image_url",
                        "image_url": {"url": data_url}
                    })
                    logger.debug(
                        "[Vision] 添加引用图片 node_id=%s (本地URL→压缩data URL)",
                        ref.get("node_id"),
                    )
                except Exception as e:
                    logger.warning(
                        "[Vision] 本地图片转 data URL 失败 node_id=%s url=%s error=%s",
                        ref.get("node_id"), image_url, e,
                    )
            elif image_url.startswith("data:"):
                # 已经是 data URL，直接使用
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": image_url}
                })
                logger.debug(
                    "[Vision] 添加引用图片 node_id=%s (已是data URL)",
                    ref.get("node_id"),
                )
            else:
                # 远端 URL，直接使用（LLM API 会下载）
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": image_url}
                })
                logger.debug(
                    "[Vision] 添加引用图片 node_id=%s (远端URL)",
                    ref.get("node_id"),
                )
        
        return content_parts
