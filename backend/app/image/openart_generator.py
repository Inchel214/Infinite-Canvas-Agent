"""OpenArt CLI image source. Existing API generators are kept independently."""
from __future__ import annotations

import base64
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import tempfile

from PIL import Image

from app.image.base import BaseImageGenerator, ImageResult, display_size
from app.image.openai_generator import _fetch_image

_ROOT = Path(__file__).resolve().parents[3]


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
            raise ValueError("OpenArt 尚未登录，请运行项目中的 openart-login.command 完成登录")
        if "timeout" in detail.lower() or "deadline exceeded" in detail.lower():
            raise ValueError("OpenArt 请求超时；请先检查 OpenArt 生成记录，任务可能已提交，请勿直接重试以免重复扣点")
        raise ValueError(f"OpenArt 请求失败：{detail[-1200:] or 'CLI 执行失败'}")
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("OpenArt 返回了无法解析的结果，请检查生成记录") from exc


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

    def _generate(self, prompt: str, references: list[str] | None = None) -> ImageResult:
        # Each request owns its directory, so concurrent generations cannot mix files.
        with tempfile.TemporaryDirectory(prefix="canvas-openart-") as folder:
            output = Path(folder) / "output"
            output.mkdir()
            args = ["generate", "image", "--model", self.model, "--output", str(output) + os.sep]
            for index, url in enumerate(references or []):
                # Canvas-local URLs and data URLs must become local files for CLI upload.
                raw, mime = _fetch_image(url)
                reference = Path(folder) / f"reference-{index}{mimetypes.guess_extension(mime) or '.png'}"
                reference.write_bytes(raw)
                args.extend(["--image", str(reference)])
            args.extend(["--", prompt])
            _run(*args, timeout=300)
            for path in sorted(output.rglob("*")):
                if not path.is_file():
                    continue
                try:
                    with Image.open(path) as image:
                        image.verify()
                        real_size = image.size
                        mime = Image.MIME.get(image.format)
                except (OSError, ValueError):
                    continue
                if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                    continue
                data_url = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()
                width, height = display_size(real_size, (300, 300))
                return ImageResult(image_url=data_url, width=width, height=height, prompt=prompt)
            raise ValueError("OpenArt 未下载有效图片，请检查 OpenArt 生成记录；请勿直接重复提交")

    def generate(self, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt)

    def variate(self, source_image_url, prompt, width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt, [source_image_url])

    def edit(self, source_image_url, prompt, mask=None, width=300, height=300, size="2K") -> ImageResult:
        if mask:
            raise ValueError("OpenArt CLI 不支持蒙版局部编辑，请切换到原有 API 生图来源")
        return self._generate(prompt, [source_image_url])

    def compose(self, image_urls, prompt="", width=300, height=300, size="2K") -> ImageResult:
        return self._generate(prompt, image_urls)
