import json
import uuid

from app.agent.llm import BaseLLM, LLMResponse, MockLLM, OpenAICompatLLM
from app.agent.react_loop import ReActAgent
from app.agent.sessions import ChatSessionStore, clean_profile_output
from app.canvas.state import CanvasNode
from app.canvas.store import InMemoryStore
from app.feedback import FeedbackStore, make_recipe
from app.image.mock_generator import MockImageGenerator
from app.llm_logs import RollingContextLog
from app.memory import MemoryStore
from app.tools.base import ToolManager
from app.tools.generate_image import GenerateImageTool


def test_context_log_keeps_complete_messages_and_rolls_over(tmp_path):
    log = RollingContextLog(tmp_path, files=2, max_bytes=420)
    for i in range(5):
        body = {
            "model": "test-model",
            "temperature": 0.3,
            "messages": [
                {"role": "system", "content": "完整系统提示"},
                {"role": "user", "content": f"request-{i}" + "x" * 140},
            ],
            "tools": [{"type": "function", "function": {"name": "list_nodes"}}],
        }
        log.write(body, stream=i % 2 == 0)

    paths = sorted(tmp_path.glob("context_*.jsonl"))
    assert [p.name for p in paths] == ["context_1.jsonl", "context_2.jsonl"]
    records = [
        json.loads(line)
        for path in paths
        for line in path.read_text(encoding="utf-8").splitlines()
    ]
    latest = next(
        record for record in records
        if record["messages"][1]["content"].startswith("request-4")
    )
    assert latest["messages"][1]["content"].startswith("request-4")
    assert len(latest["messages"][1]["content"]) == len("request-4") + 140
    assert latest["tools"][0]["function"]["name"] == "list_nodes"
    assert "api_key" not in json.dumps(records)


def test_oversized_single_context_is_not_truncated(tmp_path):
    log = RollingContextLog(tmp_path, files=1, max_bytes=10)
    log.write({"model": "m", "messages": [{"role": "user", "content": "长" * 1000}]}, stream=False)
    record = json.loads((tmp_path / "context_1.jsonl").read_text(encoding="utf-8"))
    assert len(record["messages"][0]["content"]) == 1000


def test_profile_is_cleaned_merged_persisted_and_restored_on_undo(tmp_path):
    sessions = ChatSessionStore(str(tmp_path))
    sessions.append_user_message("c1", "科技感官网", "round-1", {"canvas_id": "c1"})
    run1 = sessions.begin_run("c1", "科技感官网")
    clean = sessions.finish_run("c1", run1, "done", "已完成。\n<profile_delta>" + json.dumps({
        "theme": "科技感官网", "decisions": ["蓝色主视觉"], "goals": ["突出产品"]
    }) + "</profile_delta>")
    assert clean == "已完成。"
    assert sessions.get_profile("c1")["theme"] == "科技感官网"
    sessions.append_assistant_message("c1", clean, run1)
    sessions.append_user_message("c1", "改为暖色", "round-2")
    run2 = sessions.begin_run("c1", "改为暖色")
    sessions.finish_run("c1", run2, "done", '<profile_delta>{"theme":"暖色科技","decisions":["橙色点缀"]}</profile_delta>')
    sessions.append_assistant_message("c1", "已改。", run2)
    assert sessions.get_profile("c1")["theme"] == "暖色科技"

    assert sessions.delete_round_from("c1", "round-2")
    restored = sessions.get_profile("c1")
    assert restored["theme"] == "科技感官网"
    assert restored["decisions"] == ["蓝色主视觉"]
    # 重新实例化验证磁盘中的 profile 也可恢复。
    assert ChatSessionStore(str(tmp_path)).get_profile("c1") == restored


def test_profile_parser_ignores_malformed_block():
    clean, delta = clean_profile_output("正文<profile_delta>{bad}</profile_delta>")
    assert clean == "正文"
    assert delta is None


def test_preferences_similarity_merge_limit_update_and_delete(tmp_path):
    store = MemoryStore(tmp_path / "preferences.json")
    first = store.save("以后都使用简洁中文回答", "r1")
    again = store.save("以后都使用简洁中文回答", "r2")
    assert again["id"] == first["id"]
    assert again["hits"] == 2
    for i in range(25):
        store.save(f"preference-{i:02d}-{uuid.uuid4().hex}{uuid.uuid4().hex}", f"r{i}")
    items = store.list()
    assert len(items) == 20
    assert store.update(items[0]["id"], "修改后的偏好")["text"] == "修改后的偏好"
    assert store.delete(items[0]["id"])
    assert not store.delete("missing")
    assert len(store.catalog()) <= 300
    assert len(MemoryStore(tmp_path / "preferences.json").list()) == 19


def test_feedback_query_returns_recent_five_and_voids_round(tmp_path):
    store = FeedbackStore(tmp_path / "feedback")
    for i in range(7):
        node = {
            "id": f"n{i}",
            "content": f"海边 夕阳 {i}",
            "recipe": make_recipe(f"海边 夕阳 {i}", style="水彩", size="4K", model="m"),
        }
        store.record("c1", node=node, outcome="kept", round_id=f"r{i}")
    store.record(
        "c1",
        node={"id": "other", "content": "海边", "recipe": make_recipe("海边", style="油画")},
        outcome="deleted",
        round_id="other",
    )

    rows = store.query("c1", keywords=["海边"], style="水彩")
    assert len(rows) == 5
    assert [row["node_id"] for row in rows] == ["n6", "n5", "n4", "n3", "n2"]
    assert rows[0]["recipe"]["size"] == "4K"
    assert (tmp_path / "feedback" / "c1.jsonl").exists()

    store.void_round("c1", "r6")
    rows = store.query("c1", keywords=["海边"], style="水彩")
    assert [row["node_id"] for row in rows] == ["n5", "n4", "n3", "n2", "n1"]
    assert store.query("another-canvas") == []


def test_canvas_node_recipe_survives_round_trip_and_old_data():
    recipe = make_recipe("极简 科技 海报", style="扁平", size="2K", model="image-m")
    node = CanvasNode(
        id="n1", type="image", x=0, y=0, width=300, height=300,
        content="极简 科技 海报", recipe=recipe,
    )
    assert CanvasNode.from_dict(node.to_dict()).recipe == recipe
    old = node.to_dict()
    old.pop("recipe")
    assert CanvasNode.from_dict(old).recipe == {}


def test_chat_profile_delta_is_hidden_merged_and_persisted_across_chunks(tmp_path):
    class ChunkedChatLLM(BaseLLM):
        text = (
            '[chat]已记住。<profile_delta>{"theme":"极简官网",'
            '"decisions":["蓝色主视觉"]}</profile_delta>'
        )

        def chat(self, messages, tools=None):
            return LLMResponse(content=self.text)

        def chat_stream(self, messages, tools=None, on_text=None, on_reasoning=None, thinking=True):
            chunks = [
                "[ch", "at]已", "记住。", "<profile_", 'delta>{"theme":',
                '"极简官网","decisions":', '["蓝色主视觉"]}</profile_', "delta>",
            ]
            for chunk in chunks:
                on_text(chunk)
            return LLMResponse(content=self.text)

    sessions = ChatSessionStore(str(tmp_path / "chats"))
    store = InMemoryStore()
    canvas_id = store.create_canvas("t").canvas_id
    agent = ReActAgent(
        llm=ChunkedChatLLM(), tool_manager=ToolManager(), store=store,
        chat_sessions=sessions, max_steps=3,
    )
    events = []
    result = agent.run("记住项目方向", canvas_id, on_event=events.append)

    assert result.success
    assert result.message == "已记住。"
    assert sessions.get_profile(canvas_id)["theme"] == "极简官网"
    assert sessions.get_profile(canvas_id)["decisions"] == ["蓝色主视觉"]
    streamed = "".join(e.get("content", "") for e in events if e.get("type") == "delta")
    assert streamed == "已记住。"
    assert "profile_delta" not in json.dumps(events, ensure_ascii=False)
    saved = json.loads((tmp_path / "chats" / f"{canvas_id}.json").read_text(encoding="utf-8"))
    assert saved["profile"]["theme"] == "极简官网"
    assert "profile_delta" not in json.dumps(saved["runs"], ensure_ascii=False)


def test_agent_generation_persists_recipe_and_feedback_with_round_id(tmp_path):
    feedback = FeedbackStore(tmp_path / "feedback")
    sessions = ChatSessionStore(str(tmp_path / "chats"))
    store = InMemoryStore()
    canvas_id = store.create_canvas("t").canvas_id
    tools = ToolManager()
    tools.register(GenerateImageTool(MockImageGenerator()))
    agent = ReActAgent(
        llm=MockLLM(), tool_manager=tools, store=store,
        chat_sessions=sessions, feedback=feedback, max_steps=5,
    )

    result = agent.run("画一张海边夕阳", canvas_id, round_id="round-1")

    assert result.success
    created = next(iter(result.state.nodes.values()))
    assert created.recipe["size"] == "2K"
    assert created.recipe["keywords"]
    rows = feedback.query(canvas_id, keywords=["海边"])
    assert len(rows) == 1
    assert rows[0]["outcome"] == "kept"
    assert rows[0]["round_id"] == "round-1"
    assert rows[0]["node_id"] == created.id

    feedback.void_round(canvas_id, "round-1")
    assert feedback.query(canvas_id, keywords=["海边"]) == []


def test_stream_thinking_retry_logs_both_complete_requests(monkeypatch):
    logged = []

    class FakeResponse:
        def __init__(self, status_code):
            self.status_code = status_code
            self.encoding = None

        def close(self):
            pass

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

        def iter_lines(self, decode_unicode=False):
            return iter(())

    class FakeSession:
        def __init__(self):
            self.trust_env = True
            self.responses = iter([FakeResponse(400), FakeResponse(200)])

        def post(self, *args, **kwargs):
            return next(self.responses)

    monkeypatch.setattr("app.agent.llm.requests.Session", FakeSession)
    monkeypatch.setattr(
        "app.agent.llm.log_llm_request",
        lambda body, stream: logged.append(json.loads(json.dumps(body))),
    )
    llm = OpenAICompatLLM(api_key="test-only", base_url="https://example.invalid/v1")

    result = llm.chat_stream(
        [{"role": "user", "content": "完整上下文"}], thinking=False
    )

    assert result.content == ""
    assert len(logged) == 2
    assert logged[0]["thinking"] == {"type": "disabled"}
    assert "thinking" not in logged[1]
    assert all(item["messages"][0]["content"] == "完整上下文" for item in logged)


def test_undo_round_api_restores_run_profile_and_voids_feedback(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app import deps
    from app.main import app

    store = InMemoryStore()
    sessions = ChatSessionStore(str(tmp_path / "chats"))
    feedback = FeedbackStore(tmp_path / "feedback")
    canvas_id = store.create_canvas("undo").canvas_id

    initial_run = sessions.begin_run(canvas_id, "初始方向", round_id="initial")
    sessions.finish_run(
        canvas_id, initial_run, "done",
        '<profile_delta>{"theme":"旧项目"}</profile_delta>',
    )
    round_id = store.begin_round(canvas_id)
    sessions.append_user_message(
        canvas_id, "调整方向", round_id, store.get_canvas(canvas_id).to_dict()
    )
    # 不追加 assistant 消息，验证 run.round_id 自身即可关联撤回轮次。
    target_run = sessions.begin_run(canvas_id, "调整方向", round_id=round_id)
    sessions.finish_run(
        canvas_id, target_run, "done",
        '<profile_delta>{"theme":"新项目"}</profile_delta>',
    )

    state = store.get_canvas(canvas_id)
    node = CanvasNode(
        id="generated", type="image", x=0, y=0, width=300, height=300,
        content="海边夕阳", recipe=make_recipe("海边夕阳"),
    )
    state.add_node(node)
    store.save_canvas(state)
    feedback.record(canvas_id, node=node.to_dict(), outcome="kept", round_id=round_id)

    monkeypatch.setattr(deps, "store", store)
    monkeypatch.setattr(deps, "chat_sessions", sessions)
    monkeypatch.setattr(deps, "feedback_store", feedback)
    response = TestClient(app).post(
        f"/api/canvas/{canvas_id}/undo-round", params={"round_id": round_id}
    )

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert response.json()["canvas"]["nodes"] == {}
    assert sessions.get_profile(canvas_id)["theme"] == "旧项目"
    assert feedback.query(canvas_id, keywords=["海边"]) == []
    assert feedback.list(canvas_id)[-1]["event"] == "undo"
    saved = json.loads((tmp_path / "chats" / f"{canvas_id}.json").read_text(encoding="utf-8"))
    assert [run["round_id"] for run in saved["runs"]] == ["initial"]
