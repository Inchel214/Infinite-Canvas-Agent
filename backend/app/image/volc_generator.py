"""火山引擎方舟（Ark）风格图片生成器：Seedream 系列，支持自定义 base_url（中转站等）"""
from __future__ import annotations

import base64
import json
import logging
import os
import struct
import time
from typing import Iterator

import requests

from app.image.base import (
    BaseImageGenerator,
    ImageResult,
    display_size as _display_size,
    image_size_from_data_url as _image_size,
)
from app.image.files import to_sendable_ref

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
_DEFAULT_MODEL = "doubao-seedream-4-0-20260415"
# 4.0 同时支持非流式与 SSE 流式
_STREAM_DEFAULT_MODEL = "doubao-seedream-4-0-20260415"

# 流式模型（Seedream 5.0 Lite）总像素下限 3686400：不足时等比放大（32 倍数对齐）
_MIN_PIXELS = 3686400
# 其余模型（Seedream 4.0 / 5.0 Pro，实测 400 报错信息）总像素下限 921600（≈960x960）
_BASE_MIN_PIXELS = 921600

# 网络重试：偶发超时/5xx/ConnectionError 时有限重试 + 指数退避
_MAX_RETRIES = 3
_RETRY_BASE_DELAY = 1.0  # 秒，第一次重试等 1s，第二次 2s，第三次 4s


def _is_retryable(exc: Exception) -> bool:
    """判断异常是否值得重试：网络错误、超时、5xx"""
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return True
    if isinstance(exc, requests.HTTPError):
        resp = exc.response
        if resp is not None and 500 <= resp.status_code < 600:
            return True
    return False


def _sensitive_hint(code: str) -> str:
    """把 Ark 的内容安全错误码翻译成用户能看懂的原因"""
    if "SensitiveContent" not in code and "PolicyViolation" not in code:
        return ""
    if code.startswith("InputText"):
        return "提示词触发内容安全审核，请调整描述"
    if code.startswith("InputImage"):
        return "参考图触发内容安全审核，请更换参考图"
    if "PolicyViolation" in code or code.startswith("OutputImage"):
        return "输出可能涉及版权内容（如星球大战、漫威、迪士尼等受保护 IP），请改用原创描述"
    return "内容安全审核未通过，请调整描述"


def _friendly_http_error(exc: Exception) -> Exception:
    """把 Ark 返回的 {"error": {...}} 转成带原因的 ValueError，避免前端只看到 400"""
    resp = getattr(exc, "response", None)
    if resp is None:
        return exc
    try:
        payload = resp.json()
    except Exception:
        return exc
    err = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(err, dict):
        return exc
    code = str(err.get("code") or "")
    message = str(err.get("message") or "")
    logger.warning("[Volc] API 拒绝请求 status=%s code=%s message=%s", resp.status_code, code, message)
    detail = _sensitive_hint(code) or message or f"HTTP {resp.status_code}"
    return ValueError(f"图片生成被拒绝：{detail}" + (f"（{code}）" if code else ""))


def _retry_request(session: requests.Session, method: str, url: str, **kwargs) -> requests.Response:
    """带有限重试 + 指数退避的请求封装。仅对 transient 错误重试。"""
    last_exc: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            if method == "POST":
                resp = session.post(url, **kwargs)
            else:
                resp = session.get(url, **kwargs)
            resp.raise_for_status()
            return resp
        except Exception as exc:
            last_exc = exc
            if not _is_retryable(exc) or attempt == _MAX_RETRIES - 1:
                raise _friendly_http_error(exc) from exc
            delay = _RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning(
                "[Volc] 请求失败（第 %d/%d 次），%ss 后重试: %s",
                attempt + 1, _MAX_RETRIES, delay, exc,
            )
            time.sleep(delay)
    raise last_exc  # 不会到达


def _clamp_size(size: str, model: str = "") -> str:
    # "1K" 显式转像素（Lite 模型达不到下限时由下方面积钳制兜底）；"2K"/"4K" 原样透传（API 原生支持）
    if size.strip().upper() == "1K":
        size = "1024x1024"
    # 钳制阈值按模型区分：5.0 Lite 为 3686400，其余为 921600（无差别套 Lite 阈值会把
    # 合法的 1024x1024（1K）悄悄放大成 1920x1920，导致分辨率档位与实际图片不符）
    min_pixels = _MIN_PIXELS if "lite" in model.lower() else _BASE_MIN_PIXELS
    try:
        if "x" in size:
            w, h = (int(v) for v in size.lower().split("x", 1))
            if w * h < min_pixels:
                scale = (min_pixels / (w * h)) ** 0.5
                w = max(32, -(-int(w * scale) // 32) * 32)  # 向上取整到 32 倍数
                h = max(32, -(-int(h * scale) // 32) * 32)
                while w * h < min_pixels:  # 对齐后仍不足则继续加
                    if w <= h:
                        w += 32
                    else:
                        h += 32
                return f"{w}x{h}"
    except ValueError as e:
        logger.warning("尺寸规格无法钳制（原样透传）: %r: %s", size, e)
    return size


def _mask_to_bbox_tags(mask_data_url: str, max_boxes: int = 4) -> list[str]:
    """把「黑底白图」蒙版转成 Seedream 需要的归一化 <bbox> 标签（0~999，左上角为原点）。

    Ark 的 images/generations 没有 mask 入参，区域只能用坐标表达。
    多个不连续涂抹会拆成多个框，避免一个大框把中间没涂的区域也圈进去。
    """
    import io

    from PIL import Image

    try:
        raw = mask_data_url.split(",", 1)[-1]
        gray = Image.open(io.BytesIO(base64.b64decode(raw))).convert("L")
    except Exception as exc:
        logger.warning("[Volc] 蒙版解析失败，退化为整图编辑: %s", exc)
        return []

    w, h = gray.size
    if w <= 0 or h <= 0:
        return []

    # 降采样后做连通域（归一化坐标与原图尺寸无关，映射精度不受影响）
    scale = min(1.0, 200.0 / max(w, h))
    gw, gh = max(1, int(w * scale)), max(1, int(h * scale))
    small = gray.resize((gw, gh), Image.BILINEAR).point(lambda v: 255 if v > 96 else 0)
    pixels = small.load()

    visited = [[False] * gw for _ in range(gh)]
    min_area = max(4, int(gw * gh * 0.002))
    boxes: list[tuple[int, int, int, int, int]] = []

    for sy in range(gh):
        for sx in range(gw):
            if visited[sy][sx] or pixels[sx, sy] == 0:
                continue
            # 迭代式洪水填充：避免大选区时递归过深
            stack = [(sx, sy)]
            visited[sy][sx] = True
            x0 = x1 = sx
            y0 = y1 = sy
            area = 0
            while stack:
                cx, cy = stack.pop()
                area += 1
                if cx < x0:
                    x0 = cx
                elif cx > x1:
                    x1 = cx
                if cy < y0:
                    y0 = cy
                elif cy > y1:
                    y1 = cy
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < gw and 0 <= ny < gh and not visited[ny][nx] and pixels[nx, ny] > 0:
                        visited[ny][nx] = True
                        stack.append((nx, ny))
            if area >= min_area:
                boxes.append((x0, y0, x1, y1, area))

    if not boxes:
        return []

    boxes.sort(key=lambda item: item[4], reverse=True)
    tags = []
    for x0, y0, x1, y1, _ in boxes[:max_boxes]:
        tags.append(
            "<bbox>{x0} {y0} {x1} {y1}</bbox>".format(
                x0=round(x0 / gw * 999),
                y0=round(y0 / gh * 999),
                x1=round(x1 / gw * 999),
                y1=round(y1 / gh * 999),
            )
        )
    return tags


def _decode_ref(ref: str) -> bytes:
    """把 data URL 或 http URL 统一取成二进制。"""
    if ref.startswith("data:"):
        return base64.b64decode(ref.split(",", 1)[-1])
    session = requests.Session()
    session.trust_env = False
    resp = session.get(ref, timeout=30)
    resp.raise_for_status()
    return resp.content


def _composite_sketch(image_ref: str, sketch_data_url: str) -> str:
    """把用户的草图叠加到原图上，作为「标记式交互编辑」的输入。

    Seedream 没有 mask 入参，但能识别图上的手绘标记/草图，因此把笔迹直接画进输入图。
    """
    import io

    from PIL import Image

    try:
        base = Image.open(io.BytesIO(_decode_ref(image_ref))).convert("RGBA")
        overlay = Image.open(io.BytesIO(_decode_ref(sketch_data_url))).convert("RGBA")
        if overlay.size != base.size:
            overlay = overlay.resize(base.size, Image.LANCZOS)
        merged = Image.alpha_composite(base, overlay).convert("RGB")
        buf = io.BytesIO()
        merged.save(buf, format="JPEG", quality=95)
        logger.debug("[Volc] 草图已合成到输入图 size=%sx%s", merged.width, merged.height)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        logger.warning("[Volc] 草图和成失败，改用原图: %s", exc)
        return image_ref


def _build_inpaint_prompt(prompt: str, tags: list[str], has_sketch: bool = False) -> str:
    """把用户指令、区域坐标与草图清理要求组装成模型能理解的编辑指令。"""
    head = f"将图1 {'、'.join(tags)} 区域内的内容按以下要求修改：{prompt}" if tags else prompt
    keep = (
        "严格参照图1上的手绘草图生成对应内容，并移除所有草图线条，"
        "不要保留任何笔迹、描边或线稿痕迹，其余区域必须完全保持原样。"
        if has_sketch
        else (
            "其余区域必须完全保持原样，不要修改任何未框选的内容"
            "（包括未框选的人物、动物、建筑、天空、水面和前景）。"
        )
    )
    return f"{head}。{keep}"


class VolcEngineImageGenerator(BaseImageGenerator):
    """
    Ark（Seedream）风格图片生成器。
    通过 OpenAI 兼容的 images/generations 接口调用，
    支持文生图、图生图、局部编辑、多图组合（含 SSE 流式）。
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = _DEFAULT_MODEL,
        stream_model: str | None = None,
        base_url: str | None = None,
    ):
        self.api_key = api_key or os.getenv("ARK_API_KEY", "")
        if not self.api_key:
            raise ValueError("API Key 未配置，请检查 .env 文件或前端设置")
        self.model = model
        # 流式生成专用模型（需在 Ark 流式支持列表内）
        self.stream_model = stream_model or os.getenv("ARK_IMAGE_STREAM_MODEL", _STREAM_DEFAULT_MODEL)
        base_url = (base_url or os.getenv("ARK_BASE_URL") or _DEFAULT_BASE_URL).rstrip("/")
        self.api_url = f"{base_url}/images/generations"

    @staticmethod
    def _valid_refs(image_urls: list[str] | None) -> list[str]:
        """参考图：Ark 支持 http(s) URL 和 Base64 data URL；本地托管图片须转回内联 data URL"""
        if not image_urls:
            return []
        refs = []
        for u in image_urls:
            if u.startswith("data:image/"):
                refs.append(u)
            elif u.startswith("http") or u.startswith("/images/"):
                refs.append(to_sendable_ref(u))
        return refs

    def _call(
        self,
        prompt: str,
        image_urls: list[str] | None = None,
        size: str = "2K",
    ) -> str:
        """调用 Ark API，返回 data URL（base64）避免浏览器 CORS 问题"""
        import time as _time
        _t0 = _time.monotonic()
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body: dict = {
            "model": self.model,
            "prompt": prompt,
            "response_format": "url",
            "watermark": False,
        }
        if size:
            # 未指定 size 时不传该字段，交由模型默认输出（前端“自动”宽高比）
            body["size"] = _clamp_size(size, self.model)
        refs = self._valid_refs(image_urls)
        if refs:
            body["image"] = refs

        logger.debug(
            "[Volc] 生图请求 model=%s size=%s refs=%d prompt=%s",
            self.model, body.get("size", "auto"), len(refs), prompt[:80],
        )

        # trust_env=False 绕过系统代理，proxies 禁用代理
        session = requests.Session()
        session.trust_env = False
        resp = _retry_request(
            session, "POST", self.api_url,
            headers=headers,
            json=body,
            timeout=120,
            proxies={"http": None, "https": None},
        )
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
        img_resp = _retry_request(
            session, "GET", url,
            timeout=60, proxies={"http": None, "https": None},
        )
        mime = img_resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        b64 = base64.b64encode(img_resp.content).decode("ascii")
        logger.debug(
            "[Volc] 生图完成 model=%s 耗时=%dms 图片大小=%dKB",
            self.model, int((_time.monotonic() - _t0) * 1000),
            len(img_resp.content) // 1024,
        )
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
            "response_format": "url",
            "watermark": False,
            "stream": True,
        }
        if size:
            # 未指定 size 时不传，交由模型默认输出
            body["size"] = _clamp_size(size, self.stream_model)
        refs = self._valid_refs(image_urls)
        if refs:
            body["image"] = refs

        import time as _time
        _t0 = _time.monotonic()
        logger.debug(
            "[Volc] 流式生图请求 model=%s size=%s refs=%d prompt=%s",
            self.stream_model, body["size"], len(refs), prompt[:80],
        )

        session = requests.Session()
        session.trust_env = False
        resp = session.post(
            self.api_url,
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
                logger.debug("生图 SSE 坏帧跳过: %s", payload[:100])
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

        logger.debug(
            "[Volc] 流式生图完成 model=%s 耗时=%dms previews=%d",
            self.stream_model, int((_time.monotonic() - _t0) * 1000), partial_count,
        )

        # 最终图：下载转 base64 data URL（与节点存储格式一致）
        if last_url.startswith("data:"):
            final_url = last_url
        else:
            img_resp = _retry_request(
                session, "GET", last_url,
                timeout=60, proxies={"http": None, "https": None},
            )
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
        sketch: str | None = None,
    ) -> ImageResult:
        """局部编辑：Ark 无 mask 入参，改为「草图合成 + 归一化 bbox 坐标」。

        mask: 黑白蒙版 data URL，转成 <bbox> 坐标写进 prompt
        sketch: 手绘草图 data URL，按 alpha 叠加到输入图上
        两者都为空时退化为 img2img（全图重绘）。
        """
        if mask or sketch:
            url = self._call_inpaint(source_image_url, mask, prompt, size, sketch)
        else:
            # 无蒙版、无草图：退化为 img2img
            url = self._call(prompt, image_urls=[source_image_url], size=size)
        w, h = _display_size(_image_size(url), (width, height))
        return ImageResult(image_url=url, width=w, height=h, prompt=prompt)

    def _call_inpaint(
        self,
        image_url: str,
        mask: str | None,
        prompt: str,
        size: str = "2K",
        sketch: str | None = None,
    ) -> str:
        """调用 Ark inpainting API（局部编辑）。

        mask 为 base64 data URL，白色区域为要修改的部分。
        """
        import time as _time
        _t0 = _time.monotonic()

        # 把原图转为可发送格式（相对 /images/ 地址也要转成内联 data URL）；有草图时先合成到图上
        image_ref = to_sendable_ref(image_url)
        if sketch:
            image_ref = _composite_sketch(image_ref, sketch)

        # Ark 没有 mask 入参（传了会被静默忽略），区域只能用归一化 <bbox> 坐标告诉模型
        tags = _mask_to_bbox_tags(mask) if mask else []
        final_prompt = _build_inpaint_prompt(prompt, tags, bool(sketch))

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body: dict = {
            "model": self.model,
            "prompt": final_prompt,
            "response_format": "url",
            "watermark": False,
            "image": image_ref,
        }
        if size:
            # 未指定 size 时不传，交由模型默认输出
            body["size"] = _clamp_size(size, self.model)

        logger.debug(
            "[Volc] Inpainting 请求 model=%s size=%s 选区=%s prompt=%s",
            self.model, body.get("size", "auto"), tags or "无（整图）", final_prompt[:120],
        )

        session = requests.Session()
        session.trust_env = False
        resp = _retry_request(
            session, "POST", self.api_url,
            headers=headers,
            json=body,
            timeout=120,
            proxies={"http": None, "https": None},
        )
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

        # 如果是 HTTP URL，后端下载后转 base64 data URL
        img_resp = _retry_request(
            session, "GET", url,
            timeout=60, proxies={"http": None, "https": None},
        )
        mime = img_resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        b64 = base64.b64encode(img_resp.content).decode("ascii")
        logger.debug(
            "[Volc] Inpainting 完成 model=%s 耗时=%dms 图片大小=%dKB",
            self.model, int((_time.monotonic() - _t0) * 1000),
            len(img_resp.content) // 1024,
        )
        return f"data:{mime};base64,{b64}"

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
