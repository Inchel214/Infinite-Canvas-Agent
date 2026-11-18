"""Agent 冒烟测试：MockLLM 驱动完整 ReAct 循环

这组测试**不**测 LLM 答得好不好（Agent 评测体系已划线删除），而是测
ReAct 循环的**硬逻辑**：事件协议、终止语义、画布状态变更。
完全离线：MockLLM（关键词匹配）+ MockImageGenerator。
"""
from __future__ import annotations

import threading
import time

import pytest

from app.agent.llm import BaseLLM, LLMResponse, MockLLM, ToolCall
from app.agent.react_loop import CHAT_PREFIX, ReActAgent, RunControl
from app.canvas.state import CanvasNode, create_canvas
from app.canvas.store import InMemoryStore
from app.image.mock_generator import MockImageGenerator
from app.tools.ask_user import AskUserTool
from app.tools.base import ToolManager
from app.tools.generate_image import GenerateImageTool
from app.tools.list_nodes import ListNodesTool


@pytest.fixture
def agent_with_mock():
    store = InMemoryStore()
    tm = ToolManager()
    tm.register(GenerateImageTool(MockImageGenerator()))
    tm.register(ListNodesTool())
    agent = ReActAgent(
        llm=MockLLM(), tool_manager=tm, store=store, max_steps=5,
    )
    return agent, store


def _collect_events(agent, prompt, canvas_id, **kwargs):
    events = []
    result = agent.run(prompt, canvas_id, on_event=events.append, **kwargs)
    return result, events


class TestStreamProtocol:
    def test_generate_image_has_tool_events_and_state_change(self, agent_with_mock):
        agent, store = agent_with_mock
        state = store.create_canvas("t")
        cid = state.canvas_id

        result, events = _collect_events(agent, "画一张猫", cid)
        assert result.success

        etypes = [e.get("type") for e in events]
        # MockLLM 在规划阶段直接返回了带 tool_calls 的响应（不走 plan_delta），
        # 所以不断言 plan 事件，只断言工具执行和回复事件
        assert "tool_start" in etypes
        assert "tool_result" in etypes
        assert "response" in etypes

        # 最终画布确实新增了节点
        final = store.get_canvas(cid)
        assert len(final.nodes) >= 1

    def test_tool_events_come_before_response(self, agent_with_mock):
        """事件顺序：工具执行 → 回复。"""
        agent, store = agent_with_mock
        state = store.create_canvas("t")
        cid = state.canvas_id
        _, events = _collect_events(agent, "画一张狗", cid)

        idx_tool = next((i for i, e in enumerate(events) if e.get("type") == "tool_start"), -1)
        idx_response = next((i for i, e in enumerate(events) if e.get("type") == "response"), -1)
        assert idx_tool >= 0 and idx_response >= 0
        assert idx_tool < idx_response

    def test_list_nodes_tool_invoked(self, agent_with_mock):
        agent, store = agent_with_mock
        state = store.create_canvas("t")
        cid = state.canvas_id
        s2 = store.get_canvas(cid)
        s2.add_node(CanvasNode(id="n1", type="image", x=0, y=0, width=100, height=100))
        store.save_canvas(s2)

        result, events = _collect_events(agent, "列出所有图片", cid)
        assert result.success

        tool_names = [e.get("tool") for e in events if e.get("type") == "tool_start"]
        assert "list_nodes" in tool_names


class TestChatMode:
    def test_chat_prefix_skips_tool_call(self):
        """Mock LLM wrapper 返回 [chat] 前缀 → 跳过工具调用直接收尾。"""
        from app.agent.llm import BaseLLM, LLMResponse

        class ChatOnlyMock(BaseLLM):
            def chat(self, messages, tools=None):
                return LLMResponse(content=f"{CHAT_PREFIX}你好啊")

        store = InMemoryStore()
        tm = ToolManager()
        tm.register(ListNodesTool())
        agent = ReActAgent(llm=ChatOnlyMock(), tool_manager=tm, store=store, max_steps=5)

        state = store.create_canvas("t")
        result, events = _collect_events(agent, "你好", state.canvas_id)

        assert result.success
        assert result.message == "你好啊"
        tool_events = [e for e in events if e.get("type") in ("tool_start", "tool_result")]
        assert len(tool_events) == 0
        assert not any(e.get("type") == "plan_delta" for e in events)


class TestToolResultCanvasDict:
    def test_successful_tool_result_has_canvas(self, agent_with_mock):
        agent, store = agent_with_mock
        state = store.create_canvas("t")
        _, events = _collect_events(agent, "画一张鸟", state.canvas_id)

        results = [e for e in events if e.get("type") == "tool_result"]
        assert len(results) >= 1
        first = results[0]
        assert first.get("success") is True
        assert first.get("canvas") is not None
        assert "nodes" in first["canvas"]

    def test_user_activity_resets_idle_timeout(self):
        """超过原始等待时长但期间有操作，不应取消；从最后操作重新计时。"""
        control = RunControl()
        canvas_id = "idle-timeout"
        evt = control.register(canvas_id)
        assert control.request_pause(canvas_id, {"question": "请选择"})
        outcome = {}

        def wait():
            outcome["response"] = control.wait_for_response(canvas_id, timeout=1)

        worker = threading.Thread(target=wait, daemon=True)
        worker.start()
        time.sleep(0.6)
        assert control.record_activity(canvas_id)
        time.sleep(0.6)  # 距开始 1.2 秒，但距最后操作仅 0.6 秒
        assert worker.is_alive(), "有用户操作时不应按最初的 1 秒截止时间取消"
        assert control.provide_response(canvas_id, "夜景")
        worker.join(timeout=1)

        assert not worker.is_alive()
        assert outcome["response"] == "夜景"
        control.unregister(canvas_id, evt)


class TestStructuredRouting:
    def test_clarify_pauses_without_plan_and_resumes_after_response(self):
        """阻塞式澄清只出询问卡；用户回复后沿同一个 run 继续执行。"""

        class ClarifyMock(BaseLLM):
            def chat(self, messages, tools=None):
                if tools is None:
                    return LLMResponse(content=(
                        '[clarify]{"question":"要修改哪一张广州塔图片？",'
                        '"options":["夜景","日景","两张都改"],'
                        '"default_action":"取消本次修改","timeout":300}'
                    ))
                tool_messages = [m.get("content", "") for m in messages if m.get("role") == "tool"]
                assert any("用户回复：夜景" in content for content in tool_messages)
                return LLMResponse(content="好的，修改夜景图。")

        store = InMemoryStore()
        tm = ToolManager()
        agent = ReActAgent(llm=ClarifyMock(), tool_manager=tm, store=store, max_steps=5)
        tm.register(AskUserTool(agent.control))
        canvas_id = store.create_canvas("t").canvas_id
        events = []
        outcome = {}

        def run_agent():
            try:
                outcome["result"] = agent.run("把广州塔换成东京塔", canvas_id, on_event=events.append)
            except Exception as exc:  # 把线程异常带回主线程断言
                outcome["error"] = exc

        worker = threading.Thread(target=run_agent, daemon=True)
        worker.start()
        deadline = time.monotonic() + 3
        while agent.control.get_pending_question(canvas_id) is None and time.monotonic() < deadline:
            if outcome.get("error"):
                raise outcome["error"]
            time.sleep(0.01)

        pending = agent.control.get_pending_question(canvas_id)
        assert pending is not None, "clarify 应暂停等待用户，而不是直接结束 run"
        assert pending["options"] == ["夜景", "日景", "两张都改"]
        assert not any(e.get("type") == "plan_delta" for e in events)
        assert not any(e.get("type") == "response" for e in events)
        ask_events = [e for e in events if e.get("type") == "ask_user"]
        assert len(ask_events) == 1
        assert ask_events[0]["question"] == "要修改哪一张广州塔图片？"

        assert agent.control.provide_response(canvas_id, "夜景")
        worker.join(timeout=3)
        assert not worker.is_alive(), "用户回复后 Agent 应继续并完成"
        if outcome.get("error"):
            raise outcome["error"]
        assert outcome["result"].success
        assert outcome["result"].message == "好的，修改夜景图。"

    def test_second_clarify_in_execution_also_uses_ask_user_card(self):
        """执行阶段二次澄清也走询问卡片，不退化为纯文字收尾。

        场景还原：第一次澄清"删除这两张吗"→ 用户"一共有三张"→ Agent 需再次
        澄清"第三张是图10吗"→ 用户"是"→ 完成。两次都必须是 ask_user 卡片。
        """

        class TwiceClarifyMock(BaseLLM):
            def __init__(self):
                self.execute_calls = 0

            def chat(self, messages, tools=None):
                if tools is None:
                    return LLMResponse(content=(
                        '[clarify]{"question":"确认删除这两张吗？","options":["确认","取消"],'
                        '"default_action":"取消","timeout":120}'
                    ))
                self.execute_calls += 1
                if self.execute_calls == 1:
                    # 执行阶段沿用文本标记的二次澄清（未走 ask_user 工具调用）
                    return LLMResponse(content=(
                        '[clarify]{"question":"第三张是图10吗？","options":["是","不是"],'
                        '"default_action":"取消","timeout":120}'
                    ))
                return LLMResponse(content="好的，一并删除这三张。")

        store = InMemoryStore()
        tm = ToolManager()
        agent = ReActAgent(llm=TwiceClarifyMock(), tool_manager=tm, store=store, max_steps=8)
        tm.register(AskUserTool(agent.control))
        canvas_id = store.create_canvas("t").canvas_id
        events = []
        outcome = {}

        def run_agent():
            try:
                outcome["result"] = agent.run("删除熊猫图片", canvas_id, on_event=events.append)
            except Exception as exc:
                outcome["error"] = exc

        def wait_question(prev=None):
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if outcome.get("error"):
                    raise outcome["error"]
                pending = agent.control.get_pending_question(canvas_id)
                if pending is not None and pending["question"] != prev:
                    return pending
                time.sleep(0.01)
            raise AssertionError("等待澄清卡片超时")

        worker = threading.Thread(target=run_agent, daemon=True)
        worker.start()

        first = wait_question()
        assert first["question"] == "确认删除这两张吗？"
        assert agent.control.provide_response(canvas_id, "一共有三张熊猫图片呢")

        second = wait_question(prev=first["question"])
        assert second["question"] == "第三张是图10吗？"
        assert agent.control.provide_response(canvas_id, "是")

        worker.join(timeout=3)
        assert not worker.is_alive(), "两次回复后 Agent 应继续并完成"
        if outcome.get("error"):
            raise outcome["error"]
        assert outcome["result"].success
        assert outcome["result"].message == "好的，一并删除这三张。"

        ask_events = [e for e in events if e.get("type") == "ask_user"]
        assert len(ask_events) == 2, "同一 run 内应出现两次 ask_user 卡片"
        # 第二次澄清不得以纯文字 response 提前收尾
        assert not any(
            e.get("type") == "response" and "图10" in e.get("content", "")
            for e in events
        )
        # clarify 原文不得通过打字机 delta 泄漏到前端
        assert not any(
            e.get("type") == "delta" and "[clarify]" in e.get("content", "")
            for e in events
        )

    def test_execute_plan_with_question_mark_is_not_misclassified(self):
        """路由由显式标记决定，不再因计划含问号/哪个而提前结束。"""

        class ExecuteMock(BaseLLM):
            def chat(self, messages, tools=None):
                if tools is None:
                    return LLMResponse(content="1. 列出画布节点。\n2. 说明当前有哪些节点？")
                if any(m.get("role") == "tool" for m in messages):
                    return LLMResponse(content="节点已列出。")
                return LLMResponse(content="", tool_calls=[ToolCall(name="list_nodes", args={})])

        store = InMemoryStore()
        tm = ToolManager()
        tm.register(ListNodesTool())
        agent = ReActAgent(llm=ExecuteMock(), tool_manager=tm, store=store, max_steps=5)
        canvas_id = store.create_canvas("t").canvas_id

        result, events = _collect_events(agent, "列出节点", canvas_id)

        assert result.success
        assert result.message == "节点已列出。"
        assert any(e.get("type") == "plan_delta" for e in events)
        assert any(e.get("type") == "tool_start" and e.get("tool") == "list_nodes" for e in events)
        assert not any(e.get("type") == "ask_user" for e in events)


class TestClarifyStreamGuard:
    """流式预检：clarify 前缀拦截、正常文本零延迟放行"""

    def test_clarify_prefix_is_suppressed_even_when_chunked(self):
        from app.agent.react_loop import _ClarifyStreamGuard

        received = []
        guard = _ClarifyStreamGuard(received.append)
        for chunk in ("[cla", "rify]", '{"question":"第三张是图10吗？"}'):
            guard.feed(chunk)
        assert guard.suppressed
        assert received == [], "clarify 原文不得推给前端 delta"

    def test_leading_whitespace_before_clarify_is_also_suppressed(self):
        from app.agent.react_loop import _ClarifyStreamGuard

        received = []
        guard = _ClarifyStreamGuard(received.append)
        guard.feed("  \n[clarify]{...}")
        assert guard.suppressed
        assert received == []

    def test_normal_text_passes_through_without_delay(self):
        from app.agent.react_loop import _ClarifyStreamGuard

        received = []
        guard = _ClarifyStreamGuard(received.append)
        guard.feed("好的，")
        guard.feed("一并删除这三张。")
        assert not guard.suppressed
        assert "".join(received) == "好的，一并删除这三张。"
