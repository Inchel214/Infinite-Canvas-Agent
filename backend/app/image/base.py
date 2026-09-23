"""图片生成服务抽象接口（预留真实 API 扩展点）"""
from __future__ import annotations

import base64
from abc import ABC, abstractmethod
from dataclasses import dataclass

# 画布节点显示尺寸：图片最长边缩放到该值
_DISPLAY_MAX = 400


def image_size_from_data_url(data_url: str) -> tuple[int, int] | None:
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


def display_size(real: tuple[int, int] | None, fallback: tuple[int, int]) -> tuple[int, int]:
    """真实尺寸按比例缩放到最长边 _DISPLAY_MAX，作为节点显示尺寸"""
    if not real or real[0] <= 0 or real[1] <= 0:
        return fallback
    w, h = real
    scale = _DISPLAY_MAX / max(w, h)
    return (max(1, round(w * scale)), max(1, round(h * scale)))


@dataclass
class ImageResult:
    """图片生成结果"""
    image_url: str          # 图片地址（URL 或 data URL）
    width: int
    height: int
    prompt: str = ""        # 实际使用的提示词


class BaseImageGenerator(ABC):
    """
    图片生成服务抽象接口。

    后续可实现 OpenAI / Stability / 通义万相等真实 API，
    只需替换 deps.py 中的 generator 实例即可。
    """

    @abstractmethod
    def generate(
        self,
        prompt: str,
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        """文生图：根据文字提示生成图片。size 支持 "1K"/"2K"/"4K" 或 "宽x高"（如 2048x1152）"""
        ...

    @abstractmethod
    def variate(
        self,
        source_image_url: str,
        prompt: str,
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        """图生图：基于参考图 + 提示词生成变体"""
        ...

    @abstractmethod
    def edit(
        self,
        source_image_url: str,
        prompt: str,
        mask: str | None = None,
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        """局部编辑：对图片进行 inpainting / outpainting"""
        ...

    @abstractmethod
    def compose(
        self,
        image_urls: list[str],
        prompt: str = "",
        width: int = 300,
        height: int = 300,
        size: str = "2K",
    ) -> ImageResult:
        """多图组合：将多张图片拼接/合成为一张"""
        ...
