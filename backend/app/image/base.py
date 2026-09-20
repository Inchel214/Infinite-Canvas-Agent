"""图片生成服务抽象接口（预留真实 API 扩展点）"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


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
