"""Agent 对话历史存储（内存 + 文件持久化，按画布隔离）

每份画布对应一份会话文件 backend/data/chats/{canvas_id}.json，包含两部分：

- messages：用户原文与 Agent 最终回复（user/assistant 文本对），保持轻量、可直接回注 LLM 上下文
- runs：每轮执行的结构化记录（状态/计划/工具参数），供"重试/继续"精确重放失败任务

工具调用的完整过程只进 runs（不注入上下文），避免上下文爆炸。
"""
from __future__ import annotations

import copy
import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

# 每画布最多保留的消息条数（一对 user/assistant 算两条），超出丢弃最早
_MAX_MESSAGES = 200

# 每次注入 LLM 上下文的历史尾部条数（防止上下文爆炸）
_MAX_CONTEXT_MESSAGES = 20

# 每画布保留的执行记录条数（超出丢弃最早）
_MAX_RUNS = 50


def format_failure_note(run: dict | None) -> str | None:
    """把最近一条未完成的执行记录压缩成上下文提示，供 Agent 精确重放。

    仅在最近一轮确实失败/停止时返回；成功轮返回 None，
    避免"上次任务已完成"的记录误导后续无关指令。
    """
    if not run or run.get("status") not in ("failed", "stopped"):
        return None

    def clip(text: object, n: int) -> str:
        s = str(text or "").replace("\n", " ").strip()
        return s if len(s) <= n else s[:n] + "…"

    # 取最后一个失败的工具步骤（成功的步骤无需重放）
    failed_step = next(
        (s for s in reversed(run.get("steps") or []) if not s.get("success", True)),
        None,
    )

    status = "已停止" if run.get("status") == "stopped" else "失败"
    lines = [f"[系统记录] 本画布最近一次未完成的任务（{status}）："]
    lines.append(f"- 指令：{clip(run.get('prompt'), 120)}")
    if run.get("plan"):
        lines.append(f"- 计划：{clip(run['plan'], 120)}")
    if failed_step:
        args = json.dumps(failed_step.get("args") or {}, ensure_ascii=False)
        lines.append(
            f"- 未完成步骤：{failed_step.get('tool')}({clip(args, 160)})"
            f" → {clip(failed_step.get('result'), 100)}"
        )
    if run.get("error"):
        lines.append(f"- 错误：{clip(run['error'], 120)}")
    lines.append(
        "如本轮用户要求「重试/继续/接着做」，请直接复用上述参数重放该步骤，不要重新询问。"
    )
    return "\n".join(lines)


class ChatSessionStore:
    """按画布维护 Agent 对话历史：内存缓存 + 磁盘懒加载/落盘"""

    def __init__(self, data_dir: str | None = None):
        if data_dir is None:
            data_dir = os.getenv("CHAT_DATA_DIR")
        if data_dir is None:
            data_dir = str(Path(__file__).resolve().parent.parent.parent / "data" / "chats")
        self._data_dir = Path(data_dir)
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, list[dict]] = {}
        # canvas_id -> 执行记录（每轮一条：状态/计划/工具参数），与 messages 同文件
        self._runs: dict[str, list[dict]] = {}

    def _path(self, canvas_id: str) -> Path:
        # canvas_id 为 uuid，直接作文件名
        return self._data_dir / f"{canvas_id}.json"

    def _ensure_loaded(self, canvas_id: str) -> None:
        """懒加载画布会话（messages + runs），读取失败按空处理"""
        if canvas_id in self._sessions:
            return
        path = self._path(canvas_id)
        if path.exists():
            try:
                with path.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                self._sessions[canvas_id] = data.get("messages", [])
                self._runs[canvas_id] = data.get("runs", [])
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("对话历史读取失败（按空处理）: %s: %s", path.name, e)
                self._sessions[canvas_id] = []
                self._runs[canvas_id] = []
        else:
            self._sessions[canvas_id] = []
            self._runs[canvas_id] = []

    def get_messages(self, canvas_id: str) -> list[dict]:
        """全量历史（前端展示用），返回副本防止外部改写内部状态"""
        self._ensure_loaded(canvas_id)
        return copy.deepcopy(self._sessions[canvas_id])

    def get_context(self, canvas_id: str) -> list[dict]:
        """注入 LLM 的历史尾部（最近 _MAX_CONTEXT_MESSAGES 条），未超限即全量"""
        msgs = self.get_messages(canvas_id)
        if len(msgs) > _MAX_CONTEXT_MESSAGES:
            msgs = msgs[-_MAX_CONTEXT_MESSAGES:]
        return msgs

    def append_round(self, canvas_id: str, user_message: str, assistant_message: str) -> None:
        """追加一轮完整对话（用户原文 + Agent 最终回复）并落盘"""
        msgs = self._messages_internal(canvas_id)
        msgs.append({"role": "user", "content": user_message})
        msgs.append({"role": "assistant", "content": assistant_message})
        # 超限丢弃最早的消息
        if len(msgs) > _MAX_MESSAGES:
            del msgs[: len(msgs) - _MAX_MESSAGES]
        self._save(canvas_id)

    def append_run(self, canvas_id: str, record: dict) -> None:
        """追加一条执行记录（状态/计划/工具参数）并落盘。

        与 messages 分离：记录不注入上下文，只在需要"重试"时被取用。
        """
        self._ensure_loaded(canvas_id)
        runs = self._runs.setdefault(canvas_id, [])
        runs.append(record)
        if len(runs) > _MAX_RUNS:
            del runs[: len(runs) - _MAX_RUNS]
        self._save(canvas_id)

    def last_run(self, canvas_id: str) -> dict | None:
        """最近一条执行记录（判断"重试/继续"指向哪个任务），无记录返回 None"""
        self._ensure_loaded(canvas_id)
        runs = self._runs.get(canvas_id) or []
        return copy.deepcopy(runs[-1]) if runs else None

    def clear(self, canvas_id: str) -> None:
        """清空对话历史与执行记录（内存 + 磁盘）"""
        self._sessions[canvas_id] = []
        self._runs[canvas_id] = []
        self._save(canvas_id)

    def delete(self, canvas_id: str) -> None:
        """画布被删除时级联清理会话"""
        self._sessions.pop(canvas_id, None)
        self._runs.pop(canvas_id, None)
        try:
            self._path(canvas_id).unlink(missing_ok=True)
        except OSError as e:
            logger.warning("会话文件删除失败: %s: %s", canvas_id, e)

    def _messages_internal(self, canvas_id: str) -> list[dict]:
        """内部可变引用（先走一遍懒加载确保已初始化）"""
        self._ensure_loaded(canvas_id)
        return self._sessions[canvas_id]

    def _save(self, canvas_id: str) -> None:
        path = self._path(canvas_id)
        payload = {
            "canvas_id": canvas_id,
            "messages": self._sessions.get(canvas_id, []),
            "runs": self._runs.get(canvas_id, []),
        }
        try:
            with path.open("w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except OSError as e:
            # 磁盘写入失败不影响内存中的会话
            logger.warning("对话历史落盘失败（仅保留内存版）: %s: %s", path.name, e)
