"""OpenArt CLI image source. Existing API generators are kept independently."""
from __future__ import annotations

import base64
import io
import json
import logging
import mimetypes
import os
import re
from math import gcd

import requests
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from PIL import Image

from app.image.base import BaseImageGenerator, ImageResult, display_size
from app.image.openai_generator import _fetch_image as _fetch_reference

_ROOT = Path(__file__).resolve().parents[3]
logger = logging.getLogger(__name__)


def _fetch_image(url: str) -> tuple[bytes, str]:
    if not url.startswith("https://cdn.openart.ai/"):
        return _fetch_reference(url)
    # The system curl resolver can reach OpenArt CDN when Python's connection
    # stalls. Keep TLS verification enabled and never send account credentials.
    try:
        result = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location",
             "--proto", "=https", "--proto-redir", "=https",
             "--connect-timeout", "10", "--max-time", "60", url],
            capture_output=True, timeout=65, check=False,
        )
        if result.returncode == 0 and result.stdout:
            with Image.open(io.BytesIO(result.stdout)) as image:
                mime = Image.MIME.get(image.format, "image/png")
            return result.stdout, mime
    except (OSError, subprocess.TimeoutExpired):
        pass
    raise ValueError("OpenArt 图片下载暂未完成，将继续按原任务查询")


def _history_id(data) -> str:
    if not isinstance(data, dict):
        return ""
    for key in ("historyId", "history_id", "id"):
        if isinstance(data.get(key), str) and data[key]:
            return data[key]
    for key in ("history", "data", "generation"):
        found = _history_id(data.get(key))
        if found:
            return found
    return ""


def _run(*args: str, timeout: int = 60):
    cli = os.getenv("OPENART_CLI", str(_ROOT / ".runtime/openart/bin/openart"))
    try:
        result = subprocess.run(
            [cli, "--json", "--no-input", "--timeout", f"{timeout}s", *args],
            capture_output=True, timeout=timeout + 10, check=False,
        )
    except FileNotFoundError as exc:
        raise ValueError("未找到 OpenArt CLI，请先安装 OpenArt") from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError("OpenArt 请求超时；任务可能已提交，请先检查 OpenArt 生成记录，避免重复扣点") from exc
    if result.returncode:
        detail = result.stderr.decode(errors="replace").strip()
        if "not logged in" in detail.lower():
            raise ValueError("OpenArt 尚未登录，请先在终端运行 openart login 完成登录")
        if "timeout" in detail.lower() or "deadline exceeded" in detail.lower():
            raise ValueError("OpenArt 请求超时；请先检查 OpenArt 生成记录，任务可能已提交，请勿直接重试以免重复扣点")
        raise ValueError(f"OpenArt 请求失败：{detail[-1200:] or 'CLI 执行失败'}")
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("OpenArt 返回了无法解析的结果，请检查生成记录") from exc


def _credentials() -> tuple[str, str]:
    # Let the CLI refresh OAuth before reusing its credential for the same official API.
    _run("account")
    path = Path.home() / ".openart" / "cli-credentials.json"
    token = os.getenv("OPENART_TOKEN", "")
    credentials = json.loads(path.read_text()) if path.exists() else {}
    token = token or credentials.get("accessToken", "")
    origin = os.getenv("OPENART_API_BASE") or credentials.get("origin") or "https://openart.ai/suite"
    if not token or not origin.startswith("https://"):
        raise ValueError("OpenArt 登录信息不可用，请重新运行 openart login")
    return origin.rstrip("/").removesuffix("/suite") + "/suite", token


def _submit(args: list[str], width: int, height: int, size: str):
    """Submit once to the CLI's official endpoint with schema-validated dimensions.

    CLI 0.1.1 exposes aspect/resolution for videos only. Its dry-run body is the
    canonical image request; local references are uploaded through the CLI first.
    """
    mode = "image2image" if "--image" in args else "text2image"
    model = args[args.index("--model") + 1]
    form = _run("model", "form", model, mode)
    properties = form.get("jsonSchema", {}).get("properties", {})
    match = re.fullmatch(r"(\d+)[xX](\d+)", size.strip())
    if match:
        width, height = map(int, match.groups())
    if width <= 0 or height <= 0:
        raise ValueError("图片尺寸必须大于 0")
    divisor = gcd(int(width), int(height))
    ratio = f"{int(width) // divisor}:{int(height) // divisor}"
    params = {}
    if "aspectRatio" in properties:
        choices = properties["aspectRatio"].get("enum", [])
        # Pixel rounding can make 21:9 become 2048:878; choose only a close preset.
        if choices and ratio not in choices:
            closest = min(choices, key=lambda item: abs(float(item.split(":")[0]) / float(item.split(":")[1]) - width / height))
            rw, rh = map(float, closest.split(":"))
            if abs((rw / rh) / (width / height) - 1) > .04:
                raise ValueError(f"OpenArt 模型不支持请求比例 {ratio}，请使用支持的比例")
            ratio = closest
        params["aspectRatio"] = ratio
    elif "width" in properties and "height" in properties:
        params.update(width=width, height=height)
    elif "size" in properties:
        params["size"] = f"{width}x{height}"
    elif width != height:
        raise ValueError("此 OpenArt 模型未提供比例参数，不能按非方形尺寸生成")
    resolution_key = "resolution" if "resolution" in properties else "resolutionTier" if "resolutionTier" in properties else None
    if resolution_key:
        resolution = (size.upper() if size.upper() in {"1K", "2K", "4K"} else
                      min(("1K", "2K", "4K"), key=lambda r: abs(int(r[0]) * 1024 - max(width, height))))
        choices = properties[resolution_key].get("enum", [])
        accepted = next((choice for choice in choices if choice.lower() == resolution.lower()), resolution)
        if choices and accepted not in choices:
            raise ValueError(f"OpenArt 模型不支持分辨率 {resolution}")
        params[resolution_key] = accepted
    prepared = list(args)
    for index, arg in enumerate(prepared[:prepared.index("--")]):
        if arg == "--image":
            uploaded = _run("upload", "add", prepared[index + 1], timeout=120)
            url = uploaded.get("url") or uploaded.get("asset", {}).get("url")
            if not url:
                raise ValueError("OpenArt 参考图上传未返回 URL")
            prepared[index + 1] = url
    template = _run(*prepared[:2], "--dry-run", *prepared[2:])
    body = template.get("body")
    if not isinstance(body, dict) or template.get("endpoint") != "POST /api/cli/v1/generate":
        raise ValueError("OpenArt CLI 请求模板无法识别，未提交生图")
    body.setdefault("params", {}).update(params)
    for index, reference in enumerate(body["params"].get("visualReferences", [])):
        reference.setdefault("id", f"canvas-reference-{index + 1}")
    origin, token = _credentials()
    try:
        # Never retry a paid submission, including an ambiguous network timeout.
        response = requests.post(origin + "/api/cli/v1/generate", json=body,
                                 headers={"Authorization": f"Bearer {token}"}, timeout=120,
                                 allow_redirects=False)
        if response.status_code >= 300:
            raise ValueError(f"OpenArt 提交失败（HTTP {response.status_code}），请检查平台记录后再决定是否重试")
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        raise ValueError("OpenArt 提交未能确认；任务可能已提交，请先检查平台记录，勿重复生图") from exc


class OpenArtImageGenerator(BaseImageGenerator):
    is_openart = True

    def __init__(self, model: str = "nano-banana-2"):
        self.model = model or "nano-banana-2"

    @staticmethod
    def check_account():
        return _run("account")

    @staticmethod
    def list_models() -> list[str]:
        data = _run("model", "list")
        items = data if isinstance(data, list) else data.get("items", data.get("data", []))
        return sorted({item["id"] for item in items
                       if isinstance(item, dict) and item.get("id")
                       and any(mode.get("mode") == "text2image"
                               for mode in (item.get("modes") or {}).get("image", []))})

    def _generate(self, prompt: str, references: list[str] | None = None, width: int = 300, height: int = 300, size: str = "2K") -> ImageResult:
        # Each request owns its directory, so concurrent generations cannot mix files.
        with tempfile.TemporaryDirectory(prefix="canvas-openart-") as folder:
            args = ["generate", "image", "--model", self.model, "--async"]
            for index, url in enumerate(references or []):
                # Canvas-local URLs and data URLs must become local files for CLI upload.
                raw, mime = _fetch_image(url)
                reference = Path(folder) / f"reference-{index}{mimetypes.guess_extension(mime) or '.png'}"
                reference.write_bytes(raw)
                args.extend(["--image", str(reference)])
            args.extend(["--", prompt])
            # Submit exactly once. CLI's combined generation/wait/download can time
            # out even when the platform already has the finished image.
            submitted = _submit(args, width, height, size)
        history_id = _history_id(submitted)
        if not history_id:
            raise ValueError("OpenArt 已提交但未返回任务 ID；请检查生成记录，勿重复提交")
        logger.info("OpenArt submitted history_id=%s model=%s", history_id, self.model)
        base = Path(os.environ["CANVAS_DATA_DIR"]).parent if os.getenv("CANVAS_DATA_DIR") else _ROOT / "backend/data"
        journal = base / "openart_jobs" / f"{uuid.uuid4().hex}.json"
        journal.parent.mkdir(parents=True, exist_ok=True)
        record = {"history_id": history_id, "model": self.model, "prompt": prompt, "status": "submitted"}
        journal.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        try:
            result = self.collect(history_id, prompt)
        except Exception as exc:
            record.update(status="collection_failed", error=str(exc))
            journal.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            raise ValueError(f"OpenArt 取图未完成（任务 {history_id}）：{exc}；可按此 ID 找回，请勿重复生图") from exc
        record["status"] = "collected"
        journal.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        return result

    def collect(self, history_id: str, prompt: str = "", timeout: int = 900) -> ImageResult:
        """Read/download an existing job only; never submits or spends credits."""
        deadline = time.monotonic() + timeout
        last_error = "等待平台完成"
        while time.monotonic() < deadline:
            try:
                data = _run("creation", "get", history_id, timeout=min(30, max(1, int(deadline - time.monotonic()))))
            except ValueError as exc:
                # Only status reads are safe to retry; submission is never retried.
                last_error = str(exc)
            else:
                status = str((data.get("history") or {}).get("status", data.get("status", ""))).lower()
                if status in {"failed", "error", "cancelled", "canceled", "rejected"}:
                    raise ValueError(f"平台任务状态：{status}")
                resources = data.get("resources") or []
                for resource in resources:
                    if resource.get("resourceType") != "image" or not resource.get("url"):
                        continue
                    # A completed resource is authoritative even if history status lags.
                    if resource.get("status") != "completed" and status != "completed":
                        continue
                    try:
                        raw, _ = _fetch_image(resource["url"])
                        with Image.open(io.BytesIO(raw)) as image:
                            image.verify()
                            real_size = image.size
                            mime = Image.MIME.get(image.format)
                    except Exception as exc:
                        last_error = f"图片下载尚未完成：{type(exc).__name__}"
                        break
                    if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                        raise ValueError("OpenArt 返回了不支持的图片格式")
                    data_url = f"data:{mime};base64," + base64.b64encode(raw).decode()
                    width, height = display_size(real_size, (300, 300))
                    logger.info("OpenArt collected history_id=%s", history_id)
                    return ImageResult(image_url=data_url, width=width, height=height, prompt=prompt)
                last_error = f"平台状态 {status or '未知'}，尚无已完成图片"
            time.sleep(min(2, max(0, deadline - time.monotonic())))
        raise ValueError(f"查询超时：{last_error}")

    def generate(self, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt, width=width, height=height, size=size)

    def variate(self, source_image_url, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt, [source_image_url], width, height, size)

    def edit(self, source_image_url, prompt, mask=None, width=300, height=300, size="2K", sketch=None) -> ImageResult:
        if mask:
            raise ValueError("OpenArt CLI 不支持蒙版局部编辑，请切换到原有 API 生图来源")
        return self._generate(prompt, [source_image_url], width, height, size)

    def compose(self, image_urls, prompt="", width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt, image_urls, width, height, size)
