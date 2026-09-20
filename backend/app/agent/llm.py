"""LLM 抽象 + Mock/Ark 实现"""
from __future__ import annotations

import json
import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass

import requests


@dataclass
class ToolCall:
    name: str
    args: dict


@dataclass
class LLMResponse:
    content: str
    tool_calls: list[ToolCall] | None = None


class BaseLLM(ABC):
    """LLM 抽象接口，后续可实现 OpenAI/Claude/Qwen"""

    @abstractmethod
    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> LLMResponse:
        ...


class MockLLM(BaseLLM):
    """
    Mock LLM，根据提示词关键词返回固定的工具调用。
    用于 MVP 阶段快速跑通闭环，无需真实 API。
    """

    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> LLMResponse:
        # 取最后一条用户消息，并从画布上下文中提取实际用户指令
        user_msg = ""
        for m in reversed(messages):
            if m["role"] == "user":
                user_msg = m["content"]
                break

        # user message 格式为 "画布当前节点：...\n\n用户指令：xxx"
        # 只取"用户指令："后的部分做匹配
        if "用户指令：" in user_msg:
            user_msg = user_msg.split("用户指令：", 1)[1].strip()

        # 检查是否已有工具调用（判断是否在循环中）
        has_tool_call = any(
            m.get("role") == "tool" for m in messages
        )

        # 如果已经执行过工具，返回结束
        if has_tool_call:
            return LLMResponse(content="操作已完成。")

        # 根据关键词匹配工具
        return self._match_tool(user_msg)

    def _match_tool(self, prompt: str) -> LLMResponse:
        # ===== 图片生成类指令（优先匹配）=====

        # 多图组合 / 拼图
        if any(k in prompt for k in ["合并", "拼图", "组合", "拼在一起", "合成一张", "结合", "融合", "两幅图", "两张图", "两图", "多张图", "把所有图"]):
            desc = self._extract_edit_prompt(prompt)
            return LLMResponse(
                content="",
                tool_calls=[ToolCall(
                    name="compose_images",
                    args={"node_ids": ["all"], "prompt": desc},
                )],
            )

        # 局部编辑 / 重绘 / 擦除（优先于图生图，因为"改成X"更常见）
        if any(k in prompt for k in ["改成", "变成", "改为", "重绘", "局部", "擦除", "编辑", "改一下", "修改", "把背景", "把左上角", "把这张"]):
            desc = self._extract_edit_prompt(prompt)
            return LLMResponse(
                content="",
                tool_calls=[ToolCall(
                    name="edit_image",
                    args={"node_id": "first", "prompt": desc or prompt},
                )],
            )

        # 图生图 / 变体 / 风格迁移
        if any(k in prompt for k in ["变体", "模仿", "参考这张", "基于这张", "换个风格", "风格迁移", "基于", "参考"]):
            desc = self._extract_edit_prompt(prompt)
            return LLMResponse(
                content="",
                tool_calls=[ToolCall(
                    name="variate_image",
                    args={"node_id": "first", "prompt": desc or prompt},
                )],
            )

        # 文生图（默认图片生成）
        if any(k in prompt for k in ["生成", "画一张", "创建图片", "做一张", "生成一张", "画个", "画一个"]):
            desc = self._extract_gen_prompt(prompt)
            return LLMResponse(
                content="",
                tool_calls=[ToolCall(
                    name="generate_image",
                    args={"prompt": desc or prompt, "x": 100, "y": 100},
                )],
            )

        # ===== 画布通用操作 =====

        # 移动节点
        if any(k in prompt for k in ["移动", "移到", "挪到", "拖到"]):
            node_id = self._extract_node_id(prompt)
            x, y = self._extract_position(prompt)
            return LLMResponse(
                content="",
                tool_calls=[ToolCall(
                    name="move_node",
                    args={"node_id": node_id or "first", "x": x, "y": y},
                )],
            )

        # 删除节点
        if any(k in prompt for k in ["删除", "删掉", "移除", "清除"]):
            node_id = self._extract_node_id(prompt)
            return LLMResponse(
                content="",
                tool_calls=[ToolCall(
                    name="delete_node",
                    args={"node_id": node_id or "first"},
                )],
            )

        # 列出/查看节点
        if any(k in prompt for k in ["列出", "查看", "有什么", "显示"]):
            return LLMResponse(
                content="",
                tool_calls=[ToolCall(name="list_nodes", args={})],
            )

        # 默认：当作文生图处理
        return LLMResponse(
            content="",
            tool_calls=[ToolCall(
                name="generate_image",
                args={"prompt": prompt, "x": 100, "y": 100},
            )],
        )

    def _extract_text(self, prompt: str) -> str:
        """从提示词中提取引号或「」中的文字"""
        match = re.search(r'[""「『](.+?)[""」』]', prompt)
        if match:
            return match.group(1)
        return ""

    def _extract_gen_prompt(self, prompt: str) -> str:
        """从文生图指令中提取图片描述"""
        quoted = self._extract_text(prompt)
        if quoted:
            return quoted

        # 去掉"生成/画/做 + 一张/一个 + 描述 + 的图片/的图"
        match = re.search(r'(?:生成|画|做|创建|生成一张|画一张|做一张)[一张个]*(.+?)(?:的图片|的图|图片|图)?$', prompt)
        if match:
            return match.group(1).strip()
        return prompt.strip()

    def _extract_edit_prompt(self, prompt: str) -> str:
        """从编辑/变体指令中提取目标描述"""
        quoted = self._extract_text(prompt)
        if quoted:
            return quoted

        # 去掉"把/将 + 这张图/第一张图 + 改成/变成/生成 + 描述"
        match = re.search(r'(?:把|将)?(?:这张图|第一张图|该图|图片)?(?:改成|变成|改为|生成|做成)(.+)', prompt)
        if match:
            return match.group(1).strip()

        # 去掉"基于/参考 + 这张图 + 生成 + 描述"
        match = re.search(r'(?:基于|参考|模仿)(?:这张图|第一张图|该图)?(?:生成|做|画)?(.+)', prompt)
        if match:
            return match.group(1).strip()

        return prompt.strip()

    def _extract_node_id(self, prompt: str) -> str | None:
        """提取节点 ID（MVP 简化，返回 first 表示第一个节点）"""
        if "第一个" in prompt or "首个" in prompt:
            return "first"
        if "所有" in prompt or "全部" in prompt:
            return "all"
        return None

    def _extract_position(self, prompt: str) -> tuple[float, float]:
        """提取位置关键词"""
        if "左上" in prompt:
            return (0, 0)
        if "右上" in prompt:
            return (500, 0)
        if "左下" in prompt:
            return (0, 500)
        if "右下" in prompt:
            return (500, 500)
        if "中间" in prompt or "中心" in prompt:
            return (300, 300)
        return (100, 100)


class ArkLLM(BaseLLM):
    """
    火山引擎方舟 LLM，通过 OpenAI 兼容的 chat/completions 接口调用，
    支持原生 function calling。
    """

    _API_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "doubao-seed-2-1-pro-260915",
        temperature: float = 0.3,
        timeout: int = 120,
    ):
        self.api_key = api_key or os.getenv("ARK_API_KEY", "")
        if not self.api_key:
            raise ValueError("ARK_API_KEY 未配置，请检查 .env 文件")
        self.model = model
        self.temperature = temperature
        self.timeout = timeout
        self._call_seq = 0

    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> LLMResponse:
        body: dict = {
            "model": self.model,
            "messages": self._to_openai_messages(messages),
            "temperature": self.temperature,
        }
        oai_tools = self._to_openai_tools(tools)
        if oai_tools:
            body["tools"] = oai_tools

        # trust_env=False 绕过系统代理
        session = requests.Session()
        session.trust_env = False
        resp = session.post(
            self._API_URL,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        data = resp.json()

        choice = data["choices"][0]["message"]
        content = choice.get("content") or ""

        # 解析 function calling 结果
        tool_calls: list[ToolCall] | None = None
        raw_calls = choice.get("tool_calls")
        if raw_calls:
            tool_calls = []
            for rc in raw_calls:
                fn = rc["function"]
                try:
                    args = json.loads(rc["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {"prompt": rc["function"].get("arguments", "")}
                tool_calls.append(ToolCall(name=fn["name"], args=args))

        return LLMResponse(content=content, tool_calls=tool_calls)

    def _to_openai_tools(self, tools: list[dict] | None) -> list[dict] | None:
        """把内部工具描述转换为 OpenAI function calling 格式"""
        if not tools:
            return None
        return [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["args_schema"],
                },
            }
            for t in tools
        ]

    def _to_openai_messages(self, messages: list[dict]) -> list[dict]:
        """把内部消息格式转换为 OpenAI 格式（补齐 tool_call_id）"""
        result: list[dict] = []
        pending_ids: list[str] = []
        for m in messages:
            role = m.get("role")
            if role in ("system", "user"):
                result.append({"role": role, "content": m["content"]})
            elif role == "assistant":
                calls = m.get("tool_calls")
                if calls:
                    oai_calls = []
                    pending_ids = []
                    for tc in calls:
                        self._call_seq += 1
                        call_id = f"call_{self._call_seq}"
                        oai_calls.append({
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.args, ensure_ascii=False),
                            },
                        })
                        pending_ids.append(call_id)
                    result.append({
                        "role": "assistant",
                        "content": m.get("content") or "",
                        "tool_calls": oai_calls,
                    })
                else:
                    result.append({"role": "assistant", "content": m.get("content") or ""})
            elif role == "tool":
                call_id = pending_ids.pop(0) if pending_ids else "call_0"
                result.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": m["content"],
                })
        return result
