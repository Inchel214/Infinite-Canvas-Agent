"""ProviderManager 热切换测试

全部走 Mock 路径，不打外部网络。SettingsStore 路径用 tmp_path 隔离。
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from app.agent.llm import MockLLM
from app.image.mock_generator import MockImageGenerator
from app.providers.manager import ProviderManager
from app.providers.schema import AppSettings
from app.providers.store import SettingsStore


@pytest.fixture
def mgr(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")
    return ProviderManager(store=store)


class TestDefaultFallbackToMock:
    def test_default_generator_is_mock(self, mgr):
        assert isinstance(mgr.generator, MockImageGenerator)

    def test_default_llm_is_mock(self, mgr):
        assert isinstance(mgr.llm, MockLLM)

    def test_status_shows_mock_mode(self, mgr):
        status = mgr.status()
        assert status["llm"]["mode"] == "mock"
        assert status["image"]["mode"] == "mock"


class TestUpdateHotSwap:
    def test_update_switch_to_mock_no_rebuild(self, mgr):
        """显式设 mock → 还是 Mock 实例。"""
        mgr.update(AppSettings())
        assert isinstance(mgr.llm, MockLLM)
        assert isinstance(mgr.generator, MockImageGenerator)

    def test_reset_clears_user_settings(self, tmp_path):
        store = SettingsStore(tmp_path / "settings.json")
        mgr = ProviderManager(store=store)

        # 先给 settings 文件写点东西
        store.save(AppSettings())

        mgr.reset()
        # reset 后应该还是 Mock（因为没有 .env 兜底）
        assert isinstance(mgr.llm, MockLLM)
        assert isinstance(mgr.generator, MockImageGenerator)


class TestSettingsStorePath:
    def test_settings_file_created_on_save(self, tmp_path):
        path = tmp_path / "settings.json"
        store = SettingsStore(path)
        assert not path.exists()
        store.save(AppSettings())
        assert path.exists()

    def test_load_returns_default_when_missing(self, tmp_path):
        store = SettingsStore(tmp_path / "settings.json")
        s = store.load()
        assert isinstance(s, AppSettings)
