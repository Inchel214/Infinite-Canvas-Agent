"""火山引擎方舟（Ark）图片生成器：调用 Doubao Seedream 真实 API"""
from __future__ import annotations

import base64
import json
import os
import struct
from typing import Iterator

import requests

from app.image.base import BaseImageGenerator, ImageResult

_API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
_DEFAULT_MODEL = "doubao-seedream-4-0-20260415"
# 4.0 同时支持非流式与 SSE 流式
_STREAM_DEFAULT_MODEL = "doubao-seedream-4-0-20260415"

# 画布节点显示尺寸：图片最长边缩放到该值
_DISPLAY_MAX = 400


def _image_size(data_url: str) -> tuple[int, int] | None:
    """从 data URL 解析真实宽高（支持 PNG/JPEG/WEBP 等），失败返回 None"""
    try:
        from PIL import Image
        import io
        b64 = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
        raw = base64.b64decode(b64)
        with Image.open(io.BytesIO(raw)) as im:
            return (int(im.width), int(im.height))
    except Exception:
        return None


def _display_size(real: tuple[int, int] | None, fallback: tuple[int, int]) -> tuple[int, int]:
    """真实尺寸按比例缩放到最长边 _DISPLAY_MAX，作为节点显示尺寸"""
    if not real or real[0] <= 0 or real[1] <= 0:
        return fallback
    w, h = real
    scale = _DISPLAY_MAX / max(w, h)
    return (max(1, round(w * scale)), max(1, round(h * scale)))


class VolcEngineImageGenerator(BaseImageGenerator):
    """
    火山引擎方舟图片生成器。

    通过 Ark API 调用 Doubao Seedream 模型，
    支持文生图、图生图、局部编辑、多图组合。
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = _DEFAULT_MODEL,
        stream_model: str | None = None,
    ):
        self.api_key = api_key or os.getenv("ARK_API_KEY", "")
        if not self.api_key:
            raise ValueError("ARK_API_KEY 未配置，请检查 .env 文件")
        self.model = model
        # 流式生成专用模型（需在 Ark 流式支持列表内）
        self.stream_model = stream_model or os.getenv("ARK_IMAGE_STREAM_MODEL", _STREAM_DEFAULT_MODEL)

    @staticmethod
    def _valid_refs(image_urls: list[str] | None) -> list[str]:
        """参考图：Ark 支持 http(s) URL 和 Base64 data URL 两种输入"""
        if not image_urls:
            return []
        return [u for u in image_urls if u.startswith("http") or u.startswith("data:image/")]

    def _call(
        self,
        prompt: str,
        image_urls: list[str] | None = None,
        size: str = "2K",
    ) -> str:
        """调用 Ark API，返回 data URL（base64）避免浏览器 CORS 问题"""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body: dict = {
            "model": self.model,
            "prompt": prompt,
            "size": size,
            "response_format": "url",
            "watermark": False,
        }
        refs = self._valid_refs(image_urls)
        if refs:
            body["image"] = refs

        # trust_env=False 绕过系统代理，proxies 禁用代理
        session = requests.Session()
        session.trust_env = False
        resp = session.post(
            _API_URL,
            headers=headers,
            json=body,
            timeout=120,
            proxies={"http": None, "https": None},
        )
        resp.raise_for_status()
        data = resp.json()

        items = data.get("data", [])
        if not items:
            raise ValueError(f"API 返回无图片数据: {data}")
        url = items[0].get("url") or items[0].get("b64_json", "")
        if not url:
            raise ValueError(f"API 返回数据格式异常: {items[0]}")

        # 如果已经是 base64，直接拼 data URL
        if not url.startswith("http") and not url.startswith("data:"):
            return f"data:image/jpeg;base64,{url}"

        # 如果是 HTTP URL，后端下载后转 base64 data URL（避免浏览器 CORS）
        img_resp = session.get(url, timeout=60, proxies={"http": None, "https": None})
        img_resp.raise_for_status()
        mime = img_resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        b64 = base64.b64encode(img_resp.content).decode("ascii")
        return f"data:{mime};base64,{b64}"

    def _call_stream(
        self,
        prompt: str,
        image_urls: list[str] | None = None,
        size: str = "2K",
    ) -> Iterator[dict]:
        """
        流式调用 Ark API（SSE）。

        逐步 yield 预览事件，最后一个事件为最终结果：
          {"type": "preview", "url": ..., "progress": 0-95}
          {"type": "final",  "url": data_url, "progress": 100}
        模型不支持流式时抛 ValueError，由调用方回退非流式。
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body: dict = {
            "model": self.stream_model,
            "prompt": prompt,
            "size": size,
            "response_format": "url",
            "watermark": False,
            "stream": True,
        }
        refs = self._valid_refs(image_urls)
        if refs:
            body["image"] = refs

        session = requests.Session()
        session.trust_env = False
        resp = session.post(
            _API_URL,
            headers=headers,
            json=body,
            stream=True,
            timeout=(10, 180),
            proxies={"http": None, "https": None},
        )
        if resp.status_code != 200:
            # 不支持流式的模型（如 5.0 Pro）会返回 400
            raise ValueError(f"stream not supported or bad request: HTTP {resp.status_code}")

        last_url = ""
        partial_count = 0
        for raw_line in resp.iter_lines(decode_unicode=True):
            if not raw_line or not raw_line.startswith("data:"):
                continue
            payload = raw_line[len("data:"):].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                evt = json.loads(payload)
            except json.JSONDecodeError:
                continue

            evt_type = evt.get("type", "")
            if evt_type == "image_generation.partial_succeeded":
                url = evt.get("url") or evt.get("b64_json", "")
                if not url:
                    continue
                last_url = url
                partial_count += 1
                # 预览图直接透传 Ark 临时 URL（img 标签加载不受 CORS 限制）
                yield {"type": "preview", "url": url, "progress": min(95, 35 + partial_count * 20)}
            elif evt_type == "image_generation.completed":
                break

        if not last_url:
            raise ValueError("流式响应中未收到图片数据")

        # 最终图：下载转 base64 data URL（与节点存储格式一致）
        if last_url.startswith("data:"):
            final_url = last_url
        else:
            img_resp = session.get(last_url, timeout=60, proxies={"http": None, "https": None})
            img_resp.raise_for_status()
            mime = img_resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
            b64 = base64.b64encode(img_resp.content).decode("ascii")
            final_url = f"data:{mime};base64,{b64}"
        yield {"type": "final", "url": final_url, "progress": 100}

    def generate_stream(
        self,
        prompt: str,
        image_urls: list[str] | None = None,
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> Iterator[dict]:
        """流式生成（文生图/图生图/多图组合统一入口），yield 预览 + 最终 ImageResult"""
        for evt in self._call_stream(prompt, image_urls=image_urls, size=size):
            if evt["type"] == "final":
                w, h = _display_size(_image_size(evt["url"]), (width, height))
                yield {
                    "type": "final",
                    "result": ImageResult(
                        image_url=evt["url"], width=w, height=h, prompt=prompt
                    ),
                }
            else:
                yield evt

    def generate(
        self,
        prompt: str,
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        url = self._call(prompt, size=size)
        w, h = _display_size(_image_size(url), (width, height))
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    def variate(
        self,
        source_image_url: str,
        prompt: str,
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        url = self._call(prompt, image_urls=[source_image_url], size=size)
        w, h = _display_size(_image_size(url), (width, height))
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    def edit(
        self,
        source_image_url: str,
        prompt: str,
        mask: str | None = None,
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        url = self._call(prompt, image_urls=[source_image_url], size=size)
        w, h = _display_size(_image_size(url), (width, height))
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    def compose(
        self,
        image_urls: list[str],
        prompt: str = "",
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        url = self._call(prompt, image_urls=image_urls, size=size)
        w, h = _display_size(_image_size(url), (width, height))
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)
