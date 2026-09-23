"""OpenAI 风格图片生成器：/images/generations（文生图）+ /images/edits（图生图/编辑/组合）

适配 OpenAI（gpt-image-1 / dall-e-3）、硅基流动（FLUX / Kolors）及各类
OpenAI 兼容网关。不支持 SSE 流式，前端自动回退估算进度条模式。
"""
from __future__ import annotations

import base64
import os

import requests

from app.image.base import (
    BaseImageGenerator,
    ImageResult,
    display_size as _display_size,
    image_size_from_data_url as _image_size,
)

_DEFAULT_BASE_URL = "https://api.openai.com/v1"

# 各档位映射的目标边长（OpenAI 官方最大 1024/1536，网关普遍支持更大值）
_SIZE_MAP = {"1K": "1024x1024", "2K": "2048x2048", "4K": "2048x2048"}


def _norm_size(size: str) -> str:
    """把 1K/2K/4K 归一化为 WxH；自定义 WxH 原样透传（由服务商校验）"""
    return _SIZE_MAP.get(size.upper(), size)


def _fetch_image(url: str) -> tuple[bytes, str]:
    """把 http(s) URL 或 data URL 统一转为 (bytes, mime)"""
    if url.startswith("data:"):
        header, _, b64 = url.partition(",")
        mime = header[5:].split(";", 1)[0] or "image/png"
        return base64.b64decode(b64), mime
    session = requests.Session()
    session.trust_env = False
    resp = session.get(url, timeout=60, proxies={"http": None, "https": None})
    resp.raise_for_status()
    mime = resp.headers.get("Content-Type", "image/png").split(";")[0].strip()
    return resp.content, mime


def _mime_to_ext(mime: str) -> str:
    return {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(mime, "png")


class OpenAIImageGenerator(BaseImageGenerator):
    """OpenAI 风格图片生成器（非流式）"""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str = "gpt-image-1",
    ):
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        if not self.api_key:
            raise ValueError("API Key 未配置，请检查 .env 文件或前端设置")
        base_url = (base_url or os.getenv("OPENAI_BASE_URL") or _DEFAULT_BASE_URL).rstrip("/")
        self.generations_url = f"{base_url}/images/generations"
        self.edits_url = f"{base_url}/images/edits"
        self.model = model

    def _session(self) -> requests.Session:
        session = requests.Session()
        session.trust_env = False
        return session

    def _parse_response(self, data: dict) -> str:
        """解析 {data: [{url | b64_json}]}，统一返回 data URL"""
        items = data.get("data", [])
        if not items:
            raise ValueError(f"API 返回无图片数据: {data}")
        item = items[0]
        b64 = item.get("b64_json")
        if b64:
            return f"data:image/png;base64,{b64}"
        url = item.get("url")
        if url:
            if url.startswith("data:"):
                return url
            # http URL：下载转 base64，避免浏览器 CORS
            content, mime = _fetch_image(url)
            b64 = base64.b64encode(content).decode("ascii")
            return f"data:{mime};base64,{b64}"
        raise ValueError(f"API 返回数据格式异常: {item}")

    def _generate(self, prompt: str, size: str) -> ImageResult:
        session = self._session()
        resp = session.post(
            self.generations_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "prompt": prompt,
                "size": _norm_size(size),
            },
            timeout=180,
            proxies={"http": None, "https": None},
        )
        resp.raise_for_status()
        url = self._parse_response(resp.json())
        w, h = _display_size(_image_size(url), (300, 300))
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    def _edit(self, image_urls: list[str], prompt: str, size: str) -> ImageResult:
        """图生图/编辑/组合统一走 /images/edits（multipart 上传参考图）"""
        session = self._session()
        files = []
        for i, u in enumerate(image_urls):
            content, mime = _fetch_image(u)
            ext = _mime_to_ext(mime)
            # 多图用 image[]（gpt-image-1），单图用 image（兼容 dall-e / 各网关）
            field = "image[]" if len(image_urls) > 1 else "image"
            files.append((field, (f"ref_{i}.{ext}", content, mime)))
        resp = session.post(
            self.edits_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            data={
                "model": self.model,
                "prompt": prompt,
                "size": _norm_size(size),
            },
            files=files,
            timeout=180,
            proxies={"http": None, "https": None},
        )
        resp.raise_for_status()
        url = self._parse_response(resp.json())
        w, h = _display_size(_image_size(url), (300, 300))
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    # ---- 抽象接口实现 ----

    def generate(self, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt, size)

    def variate(self, source_image_url, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._edit([source_image_url], prompt, size)

    def edit(self, source_image_url, prompt, mask=None, width=300, height=300, size="2K") -> ImageResult:
        return self._edit([source_image_url], prompt, size)

    def compose(self, image_urls, prompt="", width=300, height=300, size="2K") -> ImageResult:
        return self._edit(image_urls, prompt, size)
