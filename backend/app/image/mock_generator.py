"""Mock 图片生成器：生成带文字的 SVG 占位图（无需真实 API）"""
from __future__ import annotations

import base64
import hashlib

from app.image.base import BaseImageGenerator, ImageResult


# 一组用于区分不同生成结果的背景色
_PALETTE = [
    "#4F46E5", "#DC2626", "#059669", "#D97706",
    "#7C3AED", "#DB2777", "#0891B2", "#65A30D",
    "#EA580C", "#2563EB",
]


def _color_for(seed: str) -> str:
    """根据种子字符串稳定地选择一个背景色"""
    idx = int(hashlib.md5(seed.encode("utf-8")).hexdigest(), 16) % len(_PALETTE)
    return _PALETTE[idx]


def _svg_data_url(label: str, sub_label: str, width: int, height: int, seed: str) -> str:
    """生成一个带文字的 SVG，编码为 data URL"""
    bg = _color_for(seed)
    # 简单的文本换行：超出宽度时截断
    max_chars = max(10, width // 18)
    label = label[:max_chars]
    sub_label = sub_label[:max_chars]

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
        f'<rect width="100%" height="100%" fill="{bg}"/>'
        f'<text x="50%" y="45%" font-family="sans-serif" font-size="20" fill="white" '
        f'text-anchor="middle" dominant-baseline="middle">{label}</text>'
        f'<text x="50%" y="62%" font-family="sans-serif" font-size="14" fill="rgba(255,255,255,0.8)" '
        f'text-anchor="middle" dominant-baseline="middle">{sub_label}</text>'
        f'</svg>'
    )
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


class MockImageGenerator(BaseImageGenerator):
    """
    Mock 图片生成器。

    不调用真实 API，返回带提示词文字的 SVG 占位图。
    不同 prompt / seed 会产生不同背景色，便于在画布上区分。
    """

    def generate(self, prompt: str, width: int = 300, height: int = 300) -> ImageResult:
        seed = f"gen:{prompt}"
        url = _svg_data_url(prompt, "[文生图]", width, height, seed)
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)

    def variate(
        self,
        source_image_url: str,
        prompt: str,
        width: int = 512,
        height: int = 512,
    ) -> ImageResult:
        seed = f"var:{prompt}:{source_image_url[:32]}"
        url = _svg_data_url(prompt, "[图生图·变体]", width, height, seed)
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)

    def edit(
        self,
        source_image_url: str,
        prompt: str,
        mask: str | None = None,
        width: int = 512,
        height: int = 512,
    ) -> ImageResult:
        seed = f"edit:{prompt}:{source_image_url[:32]}"
        tag = "[局部编辑]" if mask else "[重绘]"
        url = _svg_data_url(prompt, tag, width, height, seed)
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)

    def compose(
        self,
        image_urls: list[str],
        prompt: str = "",
        width: int = 512,
        height: int = 512,
    ) -> ImageResult:
        seed = f"comp:{prompt}:{len(image_urls)}"
        label = prompt or f"{len(image_urls)} 图组合"
        url = _svg_data_url(label, "[多图组合]", width, height, seed)
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)
