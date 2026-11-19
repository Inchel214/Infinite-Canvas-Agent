"""Focused OpenArt checks; fake generations never spend account credits."""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from fastapi.testclient import TestClient

from app import deps
from app.canvas.store import FileStore
from app.image import files as files_module
from app.image import openart_generator as module
from app.image.openai_generator import OpenAIImageGenerator
from app.image.openart_generator import OpenArtImageGenerator
from app.main import app
from app.providers.manager import ProviderManager
from app.providers.store import SettingsStore


def image_data():
    buffer = io.BytesIO()
    Image.new("RGB", (800, 400), "#8c9a7e").save(buffer, format="PNG")
    return buffer.getvalue()


class OpenArtTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        temp_path = Path(self.temp.name)
        self.env = patch.dict(os.environ, {
            **{key: "" for key in (
                "ARK_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "SILICONFLOW_API_KEY",
            )},
            # 运行期按 env 解析的路径（tasks.json / sessions 等）一并隔离
            "CANVAS_DATA_DIR": str(temp_path / "data" / "canvases"),
            "CHAT_DATA_DIR": str(temp_path / "data" / "chats"),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.store = SettingsStore(Path(self.temp.name) / "settings.json")
        self.store_patch = patch.object(deps.manager, "_store", self.store)
        self.store_patch.start()
        self.addCleanup(self.store_patch.stop)
        # deps.store 与 IMAGES_DIR 是 import 时按真实路径创建的单例/常量，
        # env patch 影响不到它们，必须显式替换——否则 POST /api/canvas
        # 会把 "OpenArt test"/"Failure test" 画布写进真实 backend/data/
        self.canvas_store_patch = patch.object(
            deps, "store", FileStore(data_dir=str(temp_path / "data" / "canvases")))
        self.canvas_store_patch.start()
        self.addCleanup(self.canvas_store_patch.stop)
        self.images_dir_patch = patch.object(
            files_module, "IMAGES_DIR", temp_path / "data" / "images")
        self.images_dir_patch.start()
        self.addCleanup(self.images_dir_patch.stop)
        deps.manager.reset()
        self.client = TestClient(app)
        self.submit_patch = patch.object(module, "_submit", side_effect=lambda args, width, height, size: module._run(*args, timeout=120))
        self.submit_patch.start()
        self.addCleanup(self.submit_patch.stop)


    def api_settings(self):
        return {"llm": {"provider": "mock"}, "image": {
            "provider": "custom", "api_key": "test-api-secret-retained",
            "base_url": "https://example.invalid/v1", "model": "original-image-model",
            "stream_model": "original-stream-model",
        }}

    def fake_generation(self, *args, **kwargs):
        if args[0:2] == ("generate", "image"):
            self.assertIn("--async", args)
            self.assertNotIn("--output", args)
            return {"historyId": "test-history"}
        if args[0:2] == ("creation", "get"):
            return {"history": {"id": "test-history", "status": "completed"}, "resources": [{
                "resourceType": "image", "status": "completed",
                "url": "data:image/png;base64," + base64.b64encode(image_data()).decode(),
            }]}
        raise AssertionError(args)

    def test_legacy_settings_and_roundtrip_preserve_api(self):
        original = self.api_settings()
        self.assertEqual(self.client.put("/api/settings", json=original).status_code, 200)
        self.assertIsInstance(deps.manager.generator, OpenAIImageGenerator)
        masked = self.client.get("/api/settings").json()
        self.assertEqual(masked["image"]["source"], "api")
        masked["image"].update(source="openart", openart_model="gpt-image-2")
        result = self.client.put("/api/settings", json=masked)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIsInstance(deps.manager.generator, OpenArtImageGenerator)
        self.assertEqual(result.json()["settings"]["status"]["image"]["mode"], "user")
        reloaded = ProviderManager(self.store)
        self.assertIsInstance(reloaded.generator, OpenArtImageGenerator)
        self.assertEqual(reloaded.settings.image.api_key, original["image"]["api_key"])
        masked = self.client.get("/api/settings").json()
        masked["image"]["source"] = "api"
        self.assertEqual(self.client.put("/api/settings", json=masked).status_code, 200)
        self.assertIsInstance(deps.manager.generator, OpenAIImageGenerator)
        for key, value in original["image"].items():
            self.assertEqual(getattr(deps.manager.settings.image, key), value)
        self.assertEqual(deps.manager.settings.image.openart_model, "gpt-image-2")

    def test_openart_no_key_models_and_failed_login(self):
        settings = {"llm": {"provider": "mock"}, "image": {"source": "openart"}}
        self.assertEqual(self.client.put("/api/settings", json=settings).status_code, 200)
        with patch.object(module, "_run", return_value=[
            {"id": "image", "modes": {"image": [{"mode": "text2image"}]}},
            {"id": "video", "modes": {"video": [{"mode": "text2video"}]}},
            {"id": "plan", "modes": {"image": [{"mode": "preview-shot-plan"}]}},
        ]):
            result = self.client.post("/api/models", json={"kind": "image", "provider": "openart"})
            self.assertEqual(result.json()["models"], ["image"])
        with patch.object(module, "_run", side_effect=ValueError("OpenArt 尚未登录")):
            result = self.client.post("/api/settings/test", json=settings)
            self.assertFalse(result.json()["image"]["ok"])
            self.assertIn("尚未登录", result.json()["image"]["message"])
        self.assertEqual(self.client.put("/api/settings", json={
            "llm": {}, "image": {"source": "invalid"},
        }).status_code, 422)

    def test_full_canvas_stream_generation_and_saved_image(self):
        self.client.put("/api/settings", json={"llm": {"provider": "mock"}, "image": {"source": "openart"}})
        canvas_id = self.client.post("/api/canvas", json={"name": "OpenArt test"}).json()["canvas_id"]
        with patch.object(module, "_run", side_effect=self.fake_generation) as run:
            result = self.client.post(f"/api/canvas/{canvas_id}/generate_stream", json={
                "prompt": "--model literal prompt", "x": 500, "y": 100, "op": "generate",
            })
        self.assertEqual(result.status_code, 200)
        events = [json.loads(line[6:]) for line in result.text.splitlines() if line.startswith("data: ")]
        self.assertTrue(events[-1]["success"], events)
        self.assertEqual(run.call_count, 2)
        args = run.call_args_list[0].args
        self.assertEqual(args[-2:], ("--", "--model literal prompt"))
        state = self.client.get(f"/api/canvas/{canvas_id}").json()
        node = state["nodes"][events[-1]["node_id"]]
        self.assertEqual(node["width"] / node["height"], 2)
        self.assertEqual(node["content"], "--model literal prompt")
        image_path = node["image_url"].split("/images/", 1)[1]
        # IMAGES_DIR 已隔离到 temp（StaticFiles 挂载仍指向真实目录，故不断言 HTTP，
        # 直接验证图片真实落盘到了隔离目录）
        self.assertTrue(
            (Path(self.temp.name) / "data" / "images" / image_path).is_file(),
            f"生成图片未落盘到隔离目录: {image_path}",
        )

    def test_reference_upload_and_mask_rejection(self):
        ref = "data:image/png;base64," + base64.b64encode(image_data()).decode()
        def fake(*args, **kwargs):
            if args[:2] == ("generate", "image"):
                paths = [Path(args[i+1]) for i, arg in enumerate(args) if arg == "--image"]
                self.assertEqual(len(paths), 2)
                self.assertEqual(paths[0].read_bytes(), image_data())
            return self.fake_generation(*args, **kwargs)
        with patch.object(module, "_run", side_effect=fake):
            result = OpenArtImageGenerator().compose([ref, ref], "combine")
            self.assertEqual((result.width, result.height), (400, 200))
        with patch.object(module, "_run") as run:
            with self.assertRaisesRegex(ValueError, "蒙版"):
                OpenArtImageGenerator().edit(ref, "edit", mask=ref)
            run.assert_not_called()

    def test_status_read_timeout_retries_without_resubmission(self):
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("creation", "get") and len(calls) == 2:
                raise ValueError("OpenArt 请求超时")
            return self.fake_generation(*args, **kwargs)
        with patch.object(module, "_run", side_effect=fake), patch.object(module.time, "sleep"):
            result = OpenArtImageGenerator().generate("recover after read timeout")
        self.assertEqual((result.width, result.height), (400, 200))
        self.assertEqual(sum(args[:2] == ("generate", "image") for args in calls), 1)
        journals = list((Path(os.environ["CANVAS_DATA_DIR"]).parent / "openart_jobs").glob("*.json"))
        self.assertEqual(json.loads(journals[0].read_text())["history_id"], "test-history")

    def test_failed_collection_retains_id_and_can_be_recovered_without_generation(self):
        with patch.object(module, "_run", return_value={"history": {"id": "saved-job"}}), \
                patch.object(OpenArtImageGenerator, "collect", side_effect=ValueError("download failed")):
            with self.assertRaisesRegex(ValueError, "saved-job"):
                OpenArtImageGenerator().generate("original prompt")
        journals = list((Path(os.environ["CANVAS_DATA_DIR"]).parent / "openart_jobs").glob("*.json"))
        self.assertEqual(json.loads(journals[0].read_text())["status"], "collection_failed")
        with patch.object(module, "_run", side_effect=self.fake_generation) as run:
            OpenArtImageGenerator().collect("saved-job")
        self.assertEqual(run.call_args.args[:3], ("creation", "get", "saved-job"))

    def test_explicit_ratio_and_resolution_reach_platform_once(self):
        self.submit_patch.stop()
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("model", "form"):
                return {"jsonSchema": {"properties": {
                    "aspectRatio": {"enum": ["1:1", "3:4", "16:9", "21:9"]},
                    "resolution": {"enum": ["1K", "2K", "4K"]},
                }}}
            if args[:2] == ("generate", "image"):
                self.assertIn("--dry-run", args)
                return {"endpoint": "POST /api/cli/v1/generate", "body": {
                    "model": "nano-banana-2", "mode": "text2image", "media": "image", "params": {"prompt": "portrait"}}}
            raise AssertionError(args)
        with patch.object(module, "_run", side_effect=fake), patch.object(module, "_credentials", return_value=("https://openart.ai/suite", "test-token")), patch.object(module.requests, "post") as post:
            post.return_value.status_code = 200
            post.return_value.json.return_value = {"historyId": "portrait-job"}
            result = module._submit(["generate", "image", "--model", "nano-banana-2", "--async", "--", "portrait"], 300, 300, "1536x2048")
            self.assertEqual(result["historyId"], "portrait-job")
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.kwargs["json"]["params"]["aspectRatio"], "3:4")
            self.assertEqual(post.call_args.kwargs["json"]["params"]["resolution"], "2K")
            post.side_effect = module.requests.Timeout()
            with self.assertRaisesRegex(ValueError, "勿重复生图"):
                module._submit(["generate", "image", "--model", "nano-banana-2", "--async", "--", "portrait"], 300, 300, "1536x2048")
            self.assertEqual(post.call_count, 2)

    def test_transient_image_download_is_retried_without_submission(self):
        from app.image.openai_generator import _fetch_image
        with patch.object(module, "_run", side_effect=self.fake_generation), patch.object(module, "_fetch_image", side_effect=[ValueError("temporary CDN error"), _fetch_image("data:image/png;base64," + base64.b64encode(image_data()).decode())]), patch.object(module.time, "sleep"):
            result = OpenArtImageGenerator().collect("completed-job", timeout=10)
        self.assertEqual((result.width, result.height), (400, 200))

    def test_terminal_failure_is_not_retried(self):
        with patch.object(module, "_run", return_value={"history": {"status": "failed"}}) as run:
            with self.assertRaisesRegex(ValueError, "failed"):
                OpenArtImageGenerator().collect("failed-job")
        self.assertEqual(run.call_count, 1)

    def test_generation_error_reaches_canvas_without_retry(self):
        self.client.put("/api/settings", json={"llm": {"provider": "mock"}, "image": {"source": "openart"}})
        canvas_id = self.client.post("/api/canvas", json={"name": "Failure test"}).json()["canvas_id"]
        with patch.object(module, "_run", side_effect=ValueError("OpenArt 请求超时；请勿直接重试")) as run:
            result = self.client.post(f"/api/canvas/{canvas_id}/generate_stream", json={"prompt": "test", "op": "generate"})
        self.assertEqual(result.status_code, 200)
        events = [json.loads(line[6:]) for line in result.text.splitlines() if line.startswith("data: ")]
        self.assertFalse(events[-1]["success"])
        self.assertIn("请勿直接重试", events[-1]["message"])
        self.assertEqual(run.call_count, 1)

    def test_cli_timeout_never_resubmits_and_login_error(self):
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("openart", 310)) as run:
            with self.assertRaisesRegex(ValueError, "避免重复扣点"):
                module._run("generate", "image", "test", timeout=300)
            self.assertEqual(run.call_count, 1)
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"not logged in")):
            with self.assertRaisesRegex(ValueError, "openart login"):
                module._run("account")


if __name__ == "__main__":
    # Run with CANVAS_DATA_DIR already set before importing app modules.
    unittest.main()
