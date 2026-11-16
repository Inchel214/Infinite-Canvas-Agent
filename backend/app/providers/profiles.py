"""已保存配置历史：配置保存成功后自动归档（含 API Key），
方便在多个服务商 / Key 之间来回切换时一键回填，无需重复输入。"""
from __future__ import annotations

import hashlib
import time

from app.providers.schema import PROVIDER_PRESETS, AppSettings, mask_key
from app.providers.store import ProfileStore

# 每类（对话 / 生图）最多保留的条目数，超出按最近使用淘汰
MAX_PER_KIND = 8


def _entry_id(kind: str, provider: str, base_url: str, api_key: str) -> str:
    """同一服务商 + 地址 + Key 视为同一条，仅更新模型名"""
    raw = f"{kind}|{provider}|{base_url}|{api_key}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _provider_name(provider: str) -> str:
    return (PROVIDER_PRESETS.get(provider) or {}).get("name", provider or "自定义")


class ProfileHistory:
    """配置历史读写 + 脱敏回显 + 占位 Key 反查"""

    def __init__(self, store: ProfileStore | None = None):
        self._store = store or ProfileStore()
        self._data = self._store.load()

    # ---------- 对外接口 ----------

    def list(self) -> dict:
        """脱敏后的历史列表（不含真实 Key）"""
        return {kind: [self._public(e) for e in self._data.get(kind, [])]
                for kind in ("llm", "image")}

    def is_empty(self) -> bool:
        return not self._data.get("llm") and not self._data.get("image")

    def record(self, settings: AppSettings) -> None:
        """配置保存成功后归档（未设置 / Mock / OpenArt 不归档）"""
        llm = settings.llm
        if llm.provider not in ("", "mock") and llm.api_key and llm.provider != "openart":
            self._upsert("llm", llm.provider, llm.api_key, llm.base_url, llm.model, "")
        image = settings.image
        if (image.source != "openart" and image.provider not in ("", "mock")
                and image.api_key and image.provider != "openart"):
            self._upsert("image", image.provider, image.api_key, image.base_url,
                         image.model, image.stream_model)
        self._store.save(self._data)

    def find_key(self, kind: str, provider: str, masked_key: str) -> str:
        """用脱敏回显（含 ****）反查真实 Key：切回历史配置时恢复密钥"""
        for entry in self._data.get(kind, []):
            if entry.get("provider") != provider:
                continue
            if mask_key(entry.get("api_key", "")) == masked_key:
                return entry.get("api_key", "")
        return ""

    def delete(self, kind: str, profile_id: str) -> bool:
        entries = self._data.get(kind, [])
        remain = [e for e in entries if e.get("id") != profile_id]
        if len(remain) == len(entries):
            return False
        self._data[kind] = remain
        self._store.save(self._data)
        return True

    # ---------- 内部实现 ----------

    @staticmethod
    def _public(entry: dict) -> dict:
        provider = entry.get("provider", "")
        api_key = entry.get("api_key", "")
        model = entry.get("model", "")
        label = " · ".join(p for p in (_provider_name(provider), model, mask_key(api_key)) if p)
        return {
            "id": entry.get("id", ""),
            "provider": provider,
            "provider_name": _provider_name(provider),
            "label": label,
            "api_key": mask_key(api_key),
            "base_url": entry.get("base_url", ""),
            "model": model,
            "stream_model": entry.get("stream_model", ""),
            "updated_at": entry.get("updated_at", 0),
        }

    def _upsert(self, kind: str, provider: str, api_key: str, base_url: str,
                model: str, stream_model: str) -> None:
        entries = self._data.setdefault(kind, [])
        pid = _entry_id(kind, provider, base_url, api_key)
        entry = next((e for e in entries if e.get("id") == pid), None)
        if entry is None:
            entry = {
                "id": pid,
                "provider": provider,
                "api_key": api_key,
                "base_url": base_url,
                "model": model,
                "stream_model": stream_model,
            }
            entries.append(entry)
        else:
            entry.update({"base_url": base_url, "model": model,
                          "stream_model": stream_model})
        entry["updated_at"] = int(time.time())
        entries.sort(key=lambda e: e.get("updated_at", 0), reverse=True)
        self._data[kind] = entries[:MAX_PER_KIND]
