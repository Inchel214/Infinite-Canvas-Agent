"""用户设置持久化：backend/data/settings.json（与画布数据同目录，已被 .gitignore）"""
from __future__ import annotations

import json
import os
from pathlib import Path

from app.providers.schema import AppSettings

_SETTINGS_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "settings.json"


class SettingsStore:
    """settings.json 读写（文件不存在时返回空设置）"""

    def __init__(self, path: Path | None = None):
        if path is None:
            env_dir = os.getenv("CANVAS_DATA_DIR")
            path = Path(env_dir).parent / "settings.json" if env_dir else _SETTINGS_FILE
        self._path = path

    def load(self) -> AppSettings:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return AppSettings.from_dict(data)
        except (FileNotFoundError, json.JSONDecodeError):
            return AppSettings()

    def save(self, settings: AppSettings) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(settings.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def clear(self) -> None:
        self._path.unlink(missing_ok=True)
