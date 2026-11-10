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
import time

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

# 网络重试：偶发超时/5xx/ConnectionError 时有限重试 + 指数退避
_MAX_RETRIES = 3
_RETRY_BASE_DELAY = 1.0


def _is_retryable(exc: Exception) -> bool:
    """判断异常是否值得重试：网络错误、超时、5xx"""
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return True
    if isinstance(exc, requests.HTTPError):
        resp = exc.response
        if resp is not None and 500 <= resp.status_code < 600:
            return True
    return False


def _retry_post(session: requests.Session, url: str, **kwargs) -> requests.Response:
    """带有限重试 + 指数退避的 POST 封装。4xx 不重试（业务错误），仅 transient 错误重试。"""
    last_exc: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            resp = session.post(url, **kwargs)
            resp.raise_for_status()
            return resp
        except Exception as exc:
            last_exc = exc
            if not _is_retryable(exc) or attempt == _MAX_RETRIES - 1:
                raise
            delay = _RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning(
                "[OpenAI] 请求失败（第 %d/%d 次），%ss 后重试: %s",
                attempt + 1, _MAX_RETRIES, delay, exc,
            )
            time.sleep(delay)
    raise last_exc  # 不会到达

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
    last_exc: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            resp = session.get(url, timeout=60, proxies={"http": None, "https": None})
            resp.raise_for_status()
            mime = resp.headers.get("Content-Type", "image/png").split(";")[0].strip()
            return resp.content, mime
        except Exception as exc:
            last_exc = exc
            if not _is_retryable(exc) or attempt == _MAX_RETRIES - 1:
                raise
            delay = _RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning(
                "[OpenAI] 图片下载失败（第 %d/%d 次），%ss 后重试: %s",
                attempt + 1, _MAX_RETRIES, delay, exc,
            )
            time.sleep(delay)
    raise last_exc  # 不会到达


def _mime_to_ext(mime: str) -> str:
    return {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(mime, "png")


def _to_alpha_mask(mask_content: bytes, target_size: tuple[int, int] | None) -> bytes:
    """把内部约定的『黑底白图』蒙版转换为 OpenAI 要求的 alpha 蒙版。

    OpenAI /images/edits 的 mask 语义：PNG 中 alpha=0（全透明）的像素才会被编辑，
    且蒙版尺寸必须与原图一致。内部约定是白色=要修改，因此：
    白色(255) → alpha 0（透明，编辑）；黑色(0) → alpha 255（不透明，保留）。
    羽化灰度会映射为半透明，实现软边缘。
    """
    import io

    from PIL import Image

    gray = Image.open(io.BytesIO(mask_content)).convert("L")
    if target_size and gray.size != target_size:
        gray = gray.resize(target_size, Image.LANCZOS)
    alpha = gray.point(lambda v: 255 - v)
    rgba = Image.new("RGBA", gray.size, (0, 0, 0, 255))
    rgba.putalpha(alpha)
    buf = io.BytesIO()
    rgba.save(buf, format="PNG")
    return buf.getvalue()


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
        import time as _time
        _t0 = _time.monotonic()
        normalized_size = _norm_size(size)
        logger.debug(
            "[OpenAI] 生图请求 model=%s size=%s prompt=%s",
            self.model, normalized_size, prompt[:80],
        )
        session = self._session()
        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            try:
                resp = session.post(
                    self.generations_url,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={
                        "model": self.model,
                        "prompt": prompt,
                        "size": normalized_size,
                    },
                    timeout=180,
                    proxies={"http": None, "https": None},
                )
                # 5xx 可重试，其余（含 4xx）走正常错误处理
                if 500 <= resp.status_code < 600 and attempt < _MAX_RETRIES - 1:
                    delay = _RETRY_BASE_DELAY * (2 ** attempt)
                    logger.warning(
                        "[OpenAI] 生图请求 HTTP %d（第 %d/%d 次），%ss 后重试",
                        resp.status_code, attempt + 1, _MAX_RETRIES, delay,
                    )
                    time.sleep(delay)
                    continue
                _raise_provider_error(resp)
                break  # 成功
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES - 1:
                    delay = _RETRY_BASE_DELAY * (2 ** attempt)
                    logger.warning(
                        "[OpenAI] 生图请求网络错误（第 %d/%d 次），%ss 后重试: %s",
                        attempt + 1, _MAX_RETRIES, delay, exc,
                    )
                    time.sleep(delay)
                    continue
                raise
        url = self._parse_response(resp.json())
        w, h = _display_size(_image_size(url), (300, 300))
        logger.debug(
            "[OpenAI] 生图完成 model=%s 耗时=%dms 尺寸=%dx%d",
            self.model, int((_time.monotonic() - _t0) * 1000), w, h,
        )
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    def _edit(self, image_urls: list[str], prompt: str, size: str) -> ImageResult:
        """图生图/编辑/组合统一走 /images/edits（multipart 上传参考图）"""
        import time as _time
        _t0 = _time.monotonic()
        logger.debug(
            "[OpenAI] 编辑请求 model=%s size=%s refs=%d prompt=%s",
            self.model, _norm_size(size), len(image_urls), prompt[:80],
        )
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
            # 网络层重试：仅对 ConnectionError/Timeout/5xx 重试，4xx 直接返回交给降级逻辑
            last_net_exc: Exception | None = None
            for attempt in range(_MAX_RETRIES):
                try:
                    resp = session.post(
                        self.edits_url,
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        data={"model": self.model, "prompt": prompt, "size": request_size},
                        files=request_files,
                        timeout=180,
                        proxies={"http": None, "https": None},
                    )
                    if 500 <= resp.status_code < 600 and attempt < _MAX_RETRIES - 1:
                        delay = _RETRY_BASE_DELAY * (2 ** attempt)
                        logger.warning(
                            "[OpenAI] 编辑请求 HTTP %d（第 %d/%d 次），%ss 后重试",
                            resp.status_code, attempt + 1, _MAX_RETRIES, delay,
                        )
                        time.sleep(delay)
                        continue
                    return resp
                except (requests.ConnectionError, requests.Timeout) as exc:
                    last_net_exc = exc
                    if attempt < _MAX_RETRIES - 1:
                        delay = _RETRY_BASE_DELAY * (2 ** attempt)
                        logger.warning(
                            "[OpenAI] 编辑请求网络错误（第 %d/%d 次），%ss 后重试: %s",
                            attempt + 1, _MAX_RETRIES, delay, exc,
                        )
                        time.sleep(delay)
                        continue
                    raise
            raise last_net_exc  # 不会到达

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
        logger.debug(
            "[OpenAI] 编辑完成 model=%s 耗时=%dms 尺寸=%dx%d",
            self.model, int((_time.monotonic() - _t0) * 1000), w, h,
        )
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    # ---- 抽象接口实现 ----

    def generate(self, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt, size)

    def variate(self, source_image_url, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._edit([source_image_url], prompt, size)

    def edit(self, source_image_url, prompt, mask=None, width=300, height=300, size="2K") -> ImageResult:
        """局部编辑（inpainting）：传入蒙版，只修改蒙版区域。

        mask: base64 data URL（PNG 格式，白色区域为要修改的部分）
        如果 mask 为空，退化为 img2img（全图重绘）。
        """
        if mask:
            # 有蒙版：调用 inpainting API
            return self._inpaint(source_image_url, mask, prompt, size)
        else:
            # 无蒙版：退化为 img2img
            return self._edit([source_image_url], prompt, size)

    def _inpaint(self, image_url: str, mask: str, prompt: str, size: str) -> ImageResult:
        """调用 OpenAI inpainting API（局部编辑）。

        使用 /images/edits 端点，传入 image + mask + prompt。
        mask 为内部约定的 base64 data URL（黑底白图，白色=要修改），
        上传前转换为 OpenAI 要求的 alpha 蒙版（透明=要修改）并与原图尺寸对齐。
        """
        import time as _time
        _t0 = _time.monotonic()
        logger.debug(
            "[OpenAI] Inpainting 请求 model=%s size=%s prompt=%s",
            self.model, _norm_size(size), prompt[:80],
        )

        session = self._session()

        # 获取原图
        image_content, image_mime = _fetch_image(image_url)
        image_ext = _mime_to_ext(image_mime)

        # 获取蒙版并转换为 OpenAI alpha 语义（透明=要修改），尺寸对齐原图
        mask_content, mask_mime = _fetch_image(mask)
        if mask_mime != "image/png":
            logger.warning("[OpenAI] 蒙版格式 %s 非 PNG，仍会转换后使用", mask_mime)
        try:
            import io

            from PIL import Image

            with Image.open(io.BytesIO(image_content)) as im:
                image_size = im.size
            mask_content = _to_alpha_mask(mask_content, image_size)
        except Exception as exc:
            logger.warning("[OpenAI] 蒙版 alpha 转换失败，按原样上传: %s", exc)

        files = [
            ("image", (f"image.{image_ext}", image_content, image_mime)),
            ("mask", ("mask.png", mask_content, "image/png")),
        ]

        requested_size = _norm_size(size)

        def post_inpaint(request_size: str) -> requests.Response:
            request_files = [
                ("image", (f"image.{image_ext}", image_content, image_mime)),
                ("mask", ("mask.png", mask_content, "image/png")),
            ]
            # 网络层重试：仅对 ConnectionError/Timeout/5xx 重试，4xx 直接返回交给降级逻辑
            last_net_exc: Exception | None = None
            for attempt in range(_MAX_RETRIES):
                try:
                    resp = session.post(
                        self.edits_url,
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        data={"model": self.model, "prompt": prompt, "size": request_size},
                        files=request_files,
                        timeout=180,
                        proxies={"http": None, "https": None},
                    )
                    if 500 <= resp.status_code < 600 and attempt < _MAX_RETRIES - 1:
                        delay = _RETRY_BASE_DELAY * (2 ** attempt)
                        logger.warning(
                            "[OpenAI] Inpainting 请求 HTTP %d（第 %d/%d 次），%ss 后重试",
                            resp.status_code, attempt + 1, _MAX_RETRIES, delay,
                        )
                        time.sleep(delay)
                        continue
                    return resp
                except (requests.ConnectionError, requests.Timeout) as exc:
                    last_net_exc = exc
                    if attempt < _MAX_RETRIES - 1:
                        delay = _RETRY_BASE_DELAY * (2 ** attempt)
                        logger.warning(
                            "[OpenAI] Inpainting 请求网络错误（第 %d/%d 次），%ss 后重试: %s",
                            attempt + 1, _MAX_RETRIES, delay, exc,
                        )
                        time.sleep(delay)
                        continue
                    raise
            raise last_net_exc  # 不会到达

        resp = post_inpaint(requested_size)
        fallback_size = _fallback_edit_size(requested_size)
        if resp.status_code == 400 and fallback_size:
            first_error = _response_error_detail(resp)
            logger.warning(
                "Inpainting 接口拒绝自定义尺寸 %s，降级为 %s 重试：%s",
                requested_size,
                fallback_size,
                first_error,
            )
            resp = post_inpaint(fallback_size)
            if not resp.ok:
                detail = _response_error_detail(resp)
                raise ValueError(
                    f"图片服务请求失败（HTTP {resp.status_code}）：{detail}"
                    f"（原尺寸 {requested_size} 被拒绝，已用兼容尺寸 {fallback_size} 重试）"
                )
        _raise_provider_error(resp)
        url = self._parse_response(resp.json())
        w, h = _display_size(_image_size(url), (300, 300))
        logger.debug(
            "[OpenAI] Inpainting 完成 model=%s 耗时=%dms 尺寸=%dx%d",
            self.model, int((_time.monotonic() - _t0) * 1000), w, h,
        )
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    def compose(self, image_urls, prompt="", width=300, height=300, size="2K") -> ImageResult:
        return self._edit(image_urls, prompt, size)
