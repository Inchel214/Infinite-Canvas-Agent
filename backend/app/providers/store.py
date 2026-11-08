"""用户设置持久化：backend/data/settings.json（与画布数据同目录，已被 .gitignore）"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from app.providers.schema import AppSettings

logger = logging.getLogger(__name__)

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
        except (FileNotFoundError, json.JSONDecodeError) as e:
            logger.warning("settings.json 读取失败（使用默认设置）: %s", e)
            return AppSettings()

    def save(self, settings: AppSettings) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(settings.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        # API key 明文存盘，尽量收紧文件权限（POSIX 下为 0600，仅当前用户可读写；
        # Windows 的 chmod 只支持只读位，此处不产生副作用）
        try:
            os.chmod(self._path, 0o600)
        except OSError as e:
            logger.debug("settings.json 权限收紧失败: %s: %s", self._path.name, e)

    def clear(self) -> None:
        self._path.unlink(missing_ok=True)
