"""Liblib Star-3: signed requests, reference upload and asynchronous generation.

No automatic submission retries: a lost response may already have created a paid task.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import re
import threading
import time
import uuid
from urllib.parse import urlsplit

import requests
from PIL import Image, ImageOps

from app.image.base import BaseImageGenerator, ImageResult, display_size
from app.image.files import to_sendable_ref

TEXT_PATH = "/api/generate/webui/text2img/ultra"
IMAGE_PATH = "/api/generate/webui/img2img/ultra"
STATUS_PATH = "/api/generate/webui/status"
UPLOAD_PATH = "/api/generate/upload/signature"
TEXT_TEMPLATE = "5d7e67009b344550bc1aa6ccbfa1d7f4"
IMAGE_TEMPLATE = "07e00af4fc464c7ab55ff906f8acf1b7"


def sign_request(path: str, secret_key: str, timestamp: str, nonce: str) -> str:
    content = f"{path}&{timestamp}&{nonce}".encode()
    digest = hmac.new(secret_key.encode(), content, hashlib.sha1).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class LiblibImageGenerator(BaseImageGenerator):
    _slots = threading.BoundedSemaphore(5)
    _submit_lock = threading.Lock()
    _last_submit = 0.0

    def __init__(self, api_key: str, secret_key: str,
                 base_url: str = "https://openapi.liblibai.cloud",
                 model: str = "star-3-alpha", reference_mode: str = "subject",
                 steps: int = 30, poll_interval: float = 3, timeout: float = 1800):
        if not api_key or not secret_key:
            raise ValueError("Liblib 需要同时填写 AccessKey 和 SecretKey")
        if model != "star-3-alpha":
            raise ValueError("当前 Liblib 接入仅支持 star-3-alpha")
        if reference_mode not in ("subject", "img2img"):
            raise ValueError("Liblib 参考方式必须为 subject 或 img2img")
        if steps not in (20, 30):
            raise ValueError("Liblib 当前支持选择 20 或 30 步")
        parsed = urlsplit(base_url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError("Liblib Base URL 必须为 HTTPS 地址，不能包含查询参数")
        self.api_key, self.secret_key = api_key, secret_key
        self.base_url = base_url.rstrip("/")
        self.model, self.reference_mode, self.steps = model, reference_mode, steps
        self.poll_interval, self.timeout = poll_interval, timeout

    def _session(self):
        session = requests.Session()
        session.trust_env = False
        return session

    def _post(self, session, path, body):
        timestamp = str(int(time.time() * 1000))
        nonce = uuid.uuid4().hex
        params = {"AccessKey": self.api_key, "Timestamp": timestamp,
                  "SignatureNonce": nonce,
                  "Signature": sign_request(path, self.secret_key, timestamp, nonce)}
        try:
            response = session.post(self.base_url + path, params=params, json=body, timeout=60)
        except requests.RequestException:
            # requests exceptions contain signed URLs; never expose them to UI/logs.
            raise ValueError("Liblib 请求未收到响应；请在控制台确认任务状态，避免重复提交") from None
        if response.status_code != 200:
            raise ValueError(f"Liblib HTTP {response.status_code}，请检查密钥、权限及接口地址")
        try:
            result = response.json()
        except ValueError:
            raise ValueError("Liblib 返回了无法解析的响应") from None
        if not isinstance(result, dict):
            raise ValueError("Liblib 响应格式错误")
        if result.get("code") != 0:
            message = str(result.get("msg") or "请求失败")[:300]
            for value in (self.api_key, self.secret_key, params["Signature"]):
                message = message.replace(value, "[已隐藏]")
            raise ValueError(f"Liblib {result.get('code')}: {message}")
        data = result.get("data")
        if not isinstance(data, dict):
            raise ValueError("Liblib 响应缺少 data")
        return data

    def check_connection(self):
        """Validate both keys without submitting a generation or spending image points."""
        with self._session() as session:
            self._post(session, UPLOAD_PATH, {"name": "canvas-connection-test.png", "extension": "png"})

    @staticmethod
    def _dimensions(size, width, height):
        match = re.fullmatch(r"(\d+)[xX×](\d+)", (size or "").strip())
        if match:
            w, h = map(int, match.groups())
        else:
            edge = {"1K": 1024, "2K": 2048}.get((size or "1K").upper())
            if edge is None:
                raise ValueError("Liblib 支持 1K、2K 或 512–2048 范围内的具体宽高，不支持 4K")
            ratio = max(0.25, min(4.0, width / max(1, height)))
            w, h = (edge, round(edge / ratio)) if ratio >= 1 else (round(edge * ratio), edge)
        if not (512 <= w <= 2048 and 512 <= h <= 2048):
            raise ValueError("Liblib 文生图宽高必须各在 512–2048 像素之间")
        return w, h

    def _reference(self, session, url):
        ref = to_sendable_ref(url)
        if not ref.startswith("data:"):
            if not ref.startswith("https://"):
                raise ValueError("Liblib 参考图必须为本地图片或可公开访问的 HTTPS 地址")
            return ref
        try:
            raw = base64.b64decode(ref.split(",", 1)[1], validate=True)
            with Image.open(io.BytesIO(raw)) as image:
                image = ImageOps.exif_transpose(image)
                image.thumbnail((2048, 2048))
                output = io.BytesIO()
                image.convert("RGBA").save(output, format="PNG")
                raw = output.getvalue()
        except (ValueError, OSError, IndexError):
            raise ValueError("无法读取 Liblib 参考图片") from None
        if len(raw) > 10 * 1024 * 1024:
            raise ValueError("Liblib 参考图不能超过 10 MB，请先压缩图片")
        name = f"canvas-{uuid.uuid4().hex}.png"
        data = self._post(session, UPLOAD_PATH, {"name": name, "extension": "png"})
        fields = {"key": data["key"], "policy": data["policy"]}
        for field in ("Date", "Expires", "Signature", "Credential", "SignatureVersion"):
            # OSS uses hyphenated names in the multipart form, camelCase in API JSON.
            key = re.sub(r"(?<!^)(?=[A-Z])", "-", field).lower()
            fields[f"x-oss-{key}"] = str(data[f"xOss{field}"])
        post_url = data["postUrl"].rstrip("/")
        if not post_url.startswith("https://"):
            raise ValueError("Liblib 返回了无效的上传地址")
        try:
            # requests appends files after data: OSS requires file to be last.
            response = session.post(post_url, data=fields,
                                    files={"file": (name, raw, "image/png")}, timeout=90)
        except requests.RequestException:
            raise ValueError("Liblib 参考图上传失败") from None
        if response.status_code not in (200, 201, 204):
            raise ValueError(f"Liblib 参考图上传失败（HTTP {response.status_code}）")
        return f"{post_url}/{data['key']}"

    def _run(self, prompt, reference, width, height, size):
        if not prompt.strip() or len(prompt) > 2000:
            raise ValueError("Liblib 提示词不能为空且不能超过 2000 字符；请使用英文提示词")
        w, h = self._dimensions(size, width, height)
        params = {"prompt": prompt, "imgCount": 1, "steps": self.steps}
        path, template = TEXT_PATH, TEXT_TEMPLATE
        with self._slots, self._session() as session:
            if reference:
                public_ref = self._reference(session, reference)
                if self.reference_mode == "img2img":
                    path, template = IMAGE_PATH, IMAGE_TEMPLATE
                    params["sourceImage"] = public_ref
                else:
                    params["controlnet"] = {"controlType": "subject", "controlImage": public_ref}
            if path == TEXT_PATH:
                params["imageSize"] = {"width": w, "height": h}
            # Shared across hot-swapped instances in this backend process.
            with self._submit_lock:
                delay = 1.05 - (time.monotonic() - type(self)._last_submit)
                if delay > 0:
                    time.sleep(delay)
                try:
                    data = self._post(session, path, {"templateUuid": template, "generateParams": params})
                finally:
                    type(self)._last_submit = time.monotonic()
            task = data.get("generateUuid")
            if not task:
                raise ValueError("Liblib 未返回任务编号，请检查控制台后再重试")
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                data = self._post(session, STATUS_PATH, {"generateUuid": task})
                status = data.get("generateStatus")
                if status == 5:
                    images = data.get("images") or []
                    if not images:
                        raise ValueError("Liblib 任务完成但未返回可用图片，请检查审核结果")
                    image = next((im for im in images if im.get("auditStatus") == 3), None)
                    if not image or not image.get("imageUrl"):
                        raise ValueError("Liblib 未返回审核通过的图片")
                    return self._download(session, image["imageUrl"], prompt, width, height)
                if status in (6, 7):
                    # Don't echo arbitrary upstream details that might contain credentials.
                    raise ValueError(f"Liblib 任务{'失败' if status == 6 else '超时'}（任务 {task}），请查看控制台")
                if status not in (1, 2, 3, 4):
                    raise ValueError(f"Liblib 返回未知任务状态（任务 {task}）")
                time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
            raise ValueError(f"Liblib 等待超时（任务 {task}）；任务可能仍在运行，请勿重复提交")

    @staticmethod
    def _download(session, url, prompt, width, height):
        if not url.startswith("https://"):
            raise ValueError("Liblib 返回了无效的图片地址")
        try:
            response = session.get(url, timeout=90)
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as image:
                real_size = image.size
                output = io.BytesIO()
                image.save(output, format="PNG")
        except (requests.RequestException, ValueError, OSError):
            raise ValueError("Liblib 图片下载失败，请在控制台找回结果，避免重复生图") from None
        # Canvas store persists data URLs into its own per-canvas image directory.
        data_url = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
        w, h = display_size(real_size, (width, height))
        return ImageResult(data_url, w, h, prompt)

    def generate(self, prompt, width=300, height=300, size="2K"):
        return self._run(prompt, None, width, height, size)

    def variate(self, source_image_url, prompt, width=300, height=300, size="2K"):
        return self._run(prompt, source_image_url, width, height, size)

    def edit(self, source_image_url, prompt, mask=None, width=300, height=300, size="2K", sketch=None):
        if mask or sketch:
            raise ValueError("当前 Liblib 星流接入不支持蒙版或草图局部编辑，请切换其他服务商")
        return self.variate(source_image_url, prompt, width, height, size)

    def compose(self, image_urls, prompt="", width=300, height=300, size="2K"):
        if len(image_urls) != 1:
            raise ValueError("当前 Liblib 星流接入仅支持单张参考图，不支持多图组合")
        return self.variate(image_urls[0], prompt, width, height, size)
