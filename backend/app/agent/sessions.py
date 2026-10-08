"""Agent 对话历史存储（内存 + 文件持久化，按画布隔离）

每份画布对应一份会话文件 backend/data/chats/{canvas_id}.json，
只存用户原文与 Agent 最终回复（user/assistant 文本对，OpenAI 消息格式），
工具调用等中间步骤不落盘，保证历史轻量、可直接回注 LLM 上下文。
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path

# 每画布最多保留的消息条数（一对 user/assistant 算两条），超出丢弃最早
_MAX_MESSAGES = 200

# 每次注入 LLM 上下文的历史尾部条数（防止上下文爆炸）
_MAX_CONTEXT_MESSAGES = 20


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

    def _path(self, canvas_id: str) -> Path:
        # canvas_id 为 uuid，直接作文件名
        return self._data_dir / f"{canvas_id}.json"

    def get_messages(self, canvas_id: str) -> list[dict]:
        """全量历史（前端展示用），返回副本防止外部改写内部状态"""
        if canvas_id not in self._sessions:
            path = self._path(canvas_id)
            if path.exists():
                try:
                    with path.open("r", encoding="utf-8") as f:
                        data = json.load(f)
                    self._sessions[canvas_id] = data.get("messages", [])
                except (json.JSONDecodeError, OSError):
                    self._sessions[canvas_id] = []
            else:
                self._sessions[canvas_id] = []
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

    def clear(self, canvas_id: str) -> None:
        """清空对话历史（内存 + 磁盘）"""
        self._sessions[canvas_id] = []
        self._save(canvas_id)

    def delete(self, canvas_id: str) -> None:
        """画布被删除时级联清理会话"""
        self._sessions.pop(canvas_id, None)
        try:
            self._path(canvas_id).unlink(missing_ok=True)
        except OSError:
            pass

    def _messages_internal(self, canvas_id: str) -> list[dict]:
        """内部可变引用（先走一遍懒加载确保已初始化）"""
        self.get_messages(canvas_id)
        return self._sessions[canvas_id]

    def _save(self, canvas_id: str) -> None:
        path = self._path(canvas_id)
        payload = {"canvas_id": canvas_id, "messages": self._sessions.get(canvas_id, [])}
        try:
            with path.open("w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except OSError:
            # 磁盘写入失败不影响内存中的会话
            pass
