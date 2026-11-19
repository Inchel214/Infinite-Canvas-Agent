"""Scoped connection probes never call the other provider or persist a draft."""
from unittest.mock import patch, Mock

import pytest
from app.api.routes import SettingsRequest, test_settings as probe
from app import experiences


def payload():
    return SettingsRequest(llm={"provider": "custom", "api_key": "fake", "base_url": "https://example.invalid/v1", "model": "test-model"}, image={"source": "openart"})


def test_llm_probe_does_not_touch_image_or_save():
    with patch("app.api.routes.requests.Session") as session, patch("app.image.openart_generator.OpenArtImageGenerator.check_account") as image, patch("app.api.routes.deps.manager.update") as save:
        session.return_value.post.return_value = Mock(status_code=200)
        result = probe(payload(), kind="llm")
        assert result["llm"]["ok"] is True
        assert result["image"] == {}
        session.return_value.post.assert_called_once()
        image.assert_not_called()
        save.assert_not_called()


def test_image_probe_does_not_touch_llm_or_save():
    with patch("app.api.routes.requests.Session") as session, patch("app.image.openart_generator.OpenArtImageGenerator.check_account") as image, patch("app.api.routes.deps.manager.update") as save:
        result = probe(payload(), kind="image")
        assert result["image"]["ok"] is True
        assert result["llm"] == {}
        image.assert_called_once()
        session.assert_not_called()
        save.assert_not_called()


def test_probe_auth_failure_is_visible():
    with patch("app.api.routes.requests.Session") as session:
        session.return_value.post.return_value = Mock(status_code=401)
        result = probe(payload(), kind="llm")
        assert result["llm"]["ok"] is False
        assert "无权限" in result["llm"]["message"]


def test_skill_body_roundtrip_and_reject_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(experiences, "EXP_DIR", tmp_path)
    monkeypatch.setattr(experiences, "REGISTRY_FILE", tmp_path / "registry.json")
    item = experiences.add_experience("test skill", "summary", "# original")
    experiences.update_experience(item["id"], "new name", "new use", "# updated body")
    loaded = experiences.read_experience(item["id"])
    assert loaded["name"] == "new name"
    assert loaded["content"] == "# updated body"
    with pytest.raises(ValueError):
        experiences.update_experience(item["id"], content="  ")
    assert experiences.read_experience(item["id"])["content"] == "# updated body"
