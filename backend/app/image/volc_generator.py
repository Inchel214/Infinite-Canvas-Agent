"""火山引擎方舟（Ark）图片生成器：调用 Doubao Seedream 真实 API"""
from __future__ import annotations

import os

import requests

from app.image.base import BaseImageGenerator, ImageResult

_API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
_DEFAULT_MODEL = "doubao-seedream-5-0-pro-260628"


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
    ):
        self.api_key = api_key or os.getenv("ARK_API_KEY", "")
        if not self.api_key:
            raise ValueError("ARK_API_KEY 未配置，请检查 .env 文件")
        self.model = model

    def _call(
        self,
        prompt: str,
        image_urls: list[str] | None = None,
    ) -> str:
        """调用 Ark API，返回 data URL（base64）避免浏览器 CORS 问题"""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body: dict = {
            "model": self.model,
            "prompt": prompt,
            "size": "2K",
            "output_format": "png",
            "response_format": "url",
            "watermark": False,
        }
        if image_urls:
            # 只传 HTTP URL，过滤掉 data URL（API 不支持 base64 输入）
            http_urls = [u for u in image_urls if u.startswith("http")]
            if http_urls:
                body["image"] = http_urls

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
            return f"data:image/png;base64,{url}"

        # 如果是 HTTP URL，后端下载后转 base64 data URL（避免浏览器 CORS）
        img_resp = session.get(url, timeout=60, proxies={"http": None, "https": None})
        img_resp.raise_for_status()
        import base64
        b64 = base64.b64encode(img_resp.content).decode("ascii")
        return f"data:image/png;base64,{b64}"

    def generate(self, prompt: str, width: int = 300, height: int = 300) -> ImageResult:
        url = self._call(prompt)
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)

    def variate(
        self,
        source_image_url: str,
        prompt: str,
        width: int = 300,
        height: int = 300,
    ) -> ImageResult:
        url = self._call(prompt, image_urls=[source_image_url])
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)

    def edit(
        self,
        source_image_url: str,
        prompt: str,
        mask: str | None = None,
        width: int = 300,
        height: int = 300,
    ) -> ImageResult:
        url = self._call(prompt, image_urls=[source_image_url])
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)

    def compose(
        self,
        image_urls: list[str],
        prompt: str = "",
        width: int = 300,
        height: int = 300,
    ) -> ImageResult:
        url = self._call(prompt, image_urls=image_urls)
        return ImageResult(image_url=url, width=width, height=height, prompt=prompt)
