"""ProviderManager：统一构建/热切换 LLM 与图片生成器实例

配置优先级：前端用户设置（settings.json）> .env 环境变量 > Mock 降级。
工具与 Agent 注入代理（Proxy），配置更新后无需重启、引用自动指向新实例。
"""
from __future__ import annotations

import os

from app.agent.llm import BaseLLM, MockLLM
from app.image.base import BaseImageGenerator
from app.providers.schema import AppSettings, LLMConfig, ImageConfig, resolve_preset
from app.providers.store import SettingsStore


class GeneratorProxy(BaseImageGenerator):
    """图片生成器代理：永远转发到 manager 当前实例（工具注册时注入，配置热切换后自动生效）"""

    def __init__(self, manager: "ProviderManager"):
        self._manager = manager

    def generate(self, prompt, width=300, height=300, size="2K"):
        return self._manager.generator.generate(prompt, width=width, height=height, size=size)

    def variate(self, source_image_url, prompt, width=300, height=300, size="2K"):
        return self._manager.generator.variate(
            source_image_url, prompt, width=width, height=height, size=size
        )

    def edit(self, source_image_url, prompt, mask=None, width=300, height=300, size="2K"):
        return self._manager.generator.edit(
            source_image_url, prompt, mask=mask, width=width, height=height, size=size
        )

    def compose(self, image_urls, prompt="", width=300, height=300, size="2K"):
        return self._manager.generator.compose(
            image_urls, prompt=prompt, width=width, height=height, size=size
        )

    def generate_stream(self, prompt, image_urls=None, width=300, height=300, size="2K"):
        """流式生成转发：底层不支持时抛 ValueError，由调用方（SSE 路由）回退非流式"""
        gen = self._manager.generator
        if not hasattr(gen, "generate_stream"):
            raise ValueError("当前图片服务商不支持流式生成")
        return gen.generate_stream(
            prompt, image_urls=image_urls, width=width, height=height, size=size
        )


class LLMProxy(BaseLLM):
    """LLM 代理：永远转发到 manager 当前实例"""

    def __init__(self, manager: "ProviderManager"):
        self._manager = manager

    def chat(self, messages, tools=None):
        return self._manager.llm.chat(messages, tools=tools)


class ProviderManager:
    def __init__(self, store: SettingsStore | None = None):
        self._store = store or SettingsStore()
        self.settings = self._store.load()
        self._generator: BaseImageGenerator
        self._llm: BaseLLM
        self._rebuild()

    # ---------- 对外接口 ----------

    def update(self, settings: AppSettings) -> None:
        """保存用户设置并热切换实例"""
        self.settings = settings
        self._store.save(settings)
        self._rebuild()

    def reset(self) -> None:
        """清除用户设置，回退 .env / Mock"""
        self._store.clear()
        self.settings = AppSettings()
        self._rebuild()

    @property
    def generator(self) -> BaseImageGenerator:
        return self._generator

    @property
    def llm(self) -> BaseLLM:
        return self._llm

    def status(self) -> dict:
        """当前生效配置摘要（供前端徽标显示）：mode = user（用户设置）/ env（.env 回退）/ mock"""
        return {
            "llm": self._conf_status(self._resolve(self.settings.llm, is_image=False),
                                     self.settings.llm),
            "image": self._conf_status(self._resolve(self.settings.image, is_image=True),
                                       self.settings.image),
        }

    # ---------- 内部实现 ----------

    @staticmethod
    def _conf_status(effective, user_conf) -> dict:
        if effective is None:
            return {"mode": "mock", "provider": "mock", "model": ""}
        is_user = user_conf.provider not in ("", "mock") and user_conf.api_key
        mode = "user" if is_user else "env"
        return {"mode": mode, "provider": effective.provider, "model": effective.model}

    def _rebuild(self) -> None:
        """根据当前 settings + 环境变量，重建 generator / llm 实例"""
        self._generator = self._build_generator()
        self._llm = self._build_llm()

    def _build_llm(self):
        conf = self._resolve(self.settings.llm, is_image=False)
        if conf is None:
            return MockLLM()
        from app.agent.llm import OpenAICompatLLM

        return OpenAICompatLLM(
            api_key=conf.api_key,
            base_url=conf.base_url,
            model=conf.model or "gpt-4o-mini",
        )

    def _build_generator(self):
        conf = self._resolve(self.settings.image, is_image=True)
        if conf is None:
            from app.image.mock_generator import MockImageGenerator

            return MockImageGenerator()
        from app.providers.schema import PROVIDER_PRESETS

        api_style = (PROVIDER_PRESETS.get(conf.provider) or {}).get("image_api", "openai")
        if api_style == "ark":
            from app.image.volc_generator import VolcEngineImageGenerator

            return VolcEngineImageGenerator(
                api_key=conf.api_key,
                base_url=conf.base_url or None,
                model=conf.model,
                stream_model=conf.stream_model or None,
            )
        # OpenAI 风格：/images/generations + /images/edits
        from app.image.openai_generator import OpenAIImageGenerator

        return OpenAIImageGenerator(
            api_key=conf.api_key,
            base_url=conf.base_url,
            model=conf.model,
        )

    def _resolve(self, conf: LLMConfig | ImageConfig, is_image: bool):
        """
        解析生效配置：用户设置 > .env > None（Mock）。
        provider 为 ""（未设置）或设置了但缺 key 时回退 .env；显式 "mock" 直接 Mock。
        返回 None 表示降级 Mock。
        """
        # 1) 用户显式选择 mock → Mock
        if conf.provider == "mock":
            return None
        # 2) 用户设置有效（选了服务商且有 key）→ 按预设补全后使用
        if conf.provider and conf.api_key:
            return resolve_preset(conf, is_image=is_image)
        # 3) 回退 .env（仅 ARK，保持向后兼容）
        env_key = os.getenv("ARK_API_KEY", "").strip()
        if env_key:
            fallback = LLMConfig(
                provider="ark",
                api_key=env_key,
                base_url="https://ark.cn-beijing.volces.com/api/v3",
                model=os.getenv("ARK_LLM_MODEL", "doubao-seed-2-1-pro-260915"),
            ) if not is_image else ImageConfig(
                provider="ark",
                api_key=env_key,
                base_url="https://ark.cn-beijing.volces.com/api/v3",
                model=os.getenv("ARK_IMAGE_MODEL", "doubao-seedream-5-0-pro-260628"),
                stream_model=os.getenv("ARK_IMAGE_STREAM_MODEL", ""),
            )
            return fallback
        # 4) 无任何配置 → Mock
        return None
