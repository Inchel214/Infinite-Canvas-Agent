"""服务商配置模型 + 内置预设（LLM 与图片生成可独立配置不同服务商）"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict


# ============ 服务商预设 ============
# llm_api:  对话模型接口风格（当前全部为 OpenAI 兼容 chat/completions）
# image_api: 图片生成接口风格："ark"（Seedream 系）| "openai"（/images/generations + /images/edits）| None（该服务商无图片能力）
PROVIDER_PRESETS: dict[str, dict] = {
    "ark": {
        "name": "火山方舟（Ark）",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "llm_api": "openai",
        "llm_model": "doubao-seed-2-1-pro-260915",
        "image_api": "ark",
        "image_model": "doubao-seedream-5-0-pro-260628",
        "stream_model": "doubao-seedream-5-0-lite-260708",
    },
    "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "llm_api": "openai",
        "llm_model": "gpt-4o-mini",
        "image_api": "openai",
        "image_model": "gpt-image-1",
        "stream_model": "",
    },
    "deepseek": {
        "name": "DeepSeek（仅对话）",
        "base_url": "https://api.deepseek.com/v1",
        "llm_api": "openai",
        "llm_model": "deepseek-chat",
        "image_api": None,
        "image_model": "",
        "stream_model": "",
    },
    "siliconflow": {
        "name": "硅基流动 SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "llm_api": "openai",
        "llm_model": "Qwen/Qwen2.5-72B-Instruct",
        "image_api": "openai",
        "image_model": "Kwai-Kolors/Kolors",
        "stream_model": "",
    },
    "custom": {
        "name": "自定义（OpenAI 兼容）",
        "base_url": "",
        "llm_api": "openai",
        "llm_model": "",
        "image_api": "openai",
        "image_model": "",
        "stream_model": "",
    },
}


@dataclass
class LLMConfig:
    """对话模型（Agent 大脑）配置"""
    provider: str = ""                 # ""=未设置（回退 .env/Mock）；"mock"=显式 Mock；其余为 PROVIDER_PRESETS 的 key
    api_key: str = ""
    base_url: str = ""                # 预设自动填充；provider=custom 时必填
    model: str = ""


@dataclass
class ImageConfig:
    """图片生成模型配置"""
    provider: str = ""                 # 同上
    api_key: str = ""
    base_url: str = ""
    model: str = ""                   # 非流式生成（编辑/变体/组合/右键菜单）
    stream_model: str = ""            # 流式生成（图片容器），留空则回退非流式


@dataclass
class AppSettings:
    """全局唯一一份应用设置"""
    llm: LLMConfig = field(default_factory=LLMConfig)
    image: ImageConfig = field(default_factory=ImageConfig)

    def to_dict(self) -> dict:
        return {"llm": asdict(self.llm), "image": asdict(self.image)}

    @classmethod
    def from_dict(cls, data: dict | None) -> "AppSettings":
        if not data:
            return cls()
        llm = LLMConfig(**{k: v for k, v in (data.get("llm") or {}).items()
                           if k in LLMConfig.__dataclass_fields__})
        image = ImageConfig(**{k: v for k, v in (data.get("image") or {}).items()
                               if k in ImageConfig.__dataclass_fields__})
        return cls(llm=llm, image=image)


def resolve_preset(config: LLMConfig | ImageConfig, is_image: bool) -> LLMConfig | ImageConfig:
    """按预设补全空缺字段：选了预设但没填 base_url/model 时自动填充默认值"""
    preset = PROVIDER_PRESETS.get(config.provider)
    if not preset:
        return config
    if not config.base_url:
        config.base_url = preset.get("base_url", "")
    if not config.model:
        key = "image_model" if is_image else "llm_model"
        config.model = preset.get(key, "") or ""
    if is_image and not config.stream_model:
        config.stream_model = preset.get("stream_model", "") or ""
    return config


def mask_key(key: str) -> str:
    """API Key 脱敏回显：保留前 3 后 4 位"""
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:3]}****{key[-4:]}"
