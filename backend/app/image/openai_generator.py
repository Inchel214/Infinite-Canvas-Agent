"""OpenAI 风格图片生成器：/images/generations（文生图）+ /images/edits（图生图/编辑/组合）

适配 OpenAI（gpt-image-1 / dall-e-3）、硅基流动（FLUX / Kolors）及各类
OpenAI 兼容网关。不支持 SSE 流式，前端自动回退估算进度条模式。
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re

import requests

from app.image.base import (
    BaseImageGenerator,
    ImageResult,
    display_size as _display_size,
    image_size_from_data_url as _image_size,
)
from app.image.files import is_local_image_url, local_url_to_data_url

_DEFAULT_BASE_URL = "https://api.openai.com/v1"
logger = logging.getLogger(__name__)

# 各档位映射的目标边长（OpenAI 官方最大 1024/1536，网关普遍支持更大值）
_SIZE_MAP = {"1K": "1024x1024", "2K": "2048x2048", "4K": "2048x2048"}

# OpenAI 图片编辑接口的通用预设。兼容网关对自定义尺寸支持不一：
# 首次仍原样请求，只在自定义尺寸被 400 拒绝时降级到同方向预设。
_OPENAI_EDIT_SIZES = ("1024x1024", "1536x1024", "1024x1536")
_PIXEL_SIZE_RE = re.compile(r"^(\d+)[xX](\d+)$")


def _norm_size(size: str) -> str:
    """把 1K/2K/4K 归一化为 WxH；自定义 WxH 原样透传（由服务商校验）"""
    return _SIZE_MAP.get(size.upper(), size)


def _fallback_edit_size(size: str) -> str | None:
    """为被网关拒绝的自定义尺寸选择同方向 OpenAI 预设。"""
    normalized = _norm_size(size)
    match = _PIXEL_SIZE_RE.fullmatch(normalized)
    if not match or normalized in _OPENAI_EDIT_SIZES:
        return None
    width, height = (int(v) for v in match.groups())
    if width > height:
        return "1536x1024"
    if height > width:
        return "1024x1536"
    return "1024x1024"


def _response_error_detail(resp: requests.Response) -> str:
    """提取上游错误正文，不记录请求头或 API Key。"""
    try:
        body = resp.json()
    except (requests.JSONDecodeError, json.JSONDecodeError, ValueError):
        body = resp.text.strip()

    if isinstance(body, dict):
        error = body.get("error", body)
        if isinstance(error, dict):
            detail = error.get("message") or error.get("detail") or error.get("code")
        else:
            detail = error
    else:
        detail = body

    text = str(detail or "").strip()
    # 防止上游返回过大页面/调试内容冲刷日志和 UI。
    return text[:800] if text else "上游未返回详细原因"


def _raise_provider_error(resp: requests.Response) -> None:
    if resp.ok:
        return
    detail = _response_error_detail(resp)
    raise ValueError(f"图片服务请求失败（HTTP {resp.status_code}）：{detail}")


def _fetch_image(url: str) -> tuple[bytes, str]:
    """把 http(s) URL、data URL 或本地托管图片 URL 统一转为 (bytes, mime)"""
    if is_local_image_url(url):
        url = local_url_to_data_url(url)
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
        _raise_provider_error(resp)
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
        requested_size = _norm_size(size)

        def post_edit(request_size: str) -> requests.Response:
            # requests 在重试 multipart 时需要重建 files，以免文件流位置留在末尾。
            request_files = []
            for field, (filename, content, mime) in files:
                request_files.append((field, (filename, content, mime)))
            return session.post(
                self.edits_url,
                headers={"Authorization": f"Bearer {self.api_key}"},
                data={"model": self.model, "prompt": prompt, "size": request_size},
                files=request_files,
                timeout=180,
                proxies={"http": None, "https": None},
            )

        resp = post_edit(requested_size)
        fallback_size = _fallback_edit_size(requested_size)
        if resp.status_code == 400 and fallback_size:
            first_error = _response_error_detail(resp)
            logger.warning(
                "图片编辑接口拒绝自定义尺寸 %s，降级为 %s 重试：%s",
                requested_size,
                fallback_size,
                first_error,
            )
            resp = post_edit(fallback_size)
            if not resp.ok:
                detail = _response_error_detail(resp)
                raise ValueError(
                    f"图片服务请求失败（HTTP {resp.status_code}）：{detail}"
                    f"（原尺寸 {requested_size} 被拒绝，已用兼容尺寸 {fallback_size} 重试）"
                )
        _raise_provider_error(resp)
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
