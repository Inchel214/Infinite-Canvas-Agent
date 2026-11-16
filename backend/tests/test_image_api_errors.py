"""Regression checks for API errors over the canvas SSE connection."""
import json
import unittest
from unittest.mock import patch

import requests
from fastapi.testclient import TestClient

from app.main import app
from app import deps
from app.canvas.state import CanvasNode
from app.canvas.store import InMemoryStore
from app.image.openai_generator import OpenAIImageGenerator


class ImageAPIErrorTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_api_denial_reaches_canvas_for_all_generation_operations(self):
        store = InMemoryStore()
        state = store.create_canvas("API error test")
        for node_id in ("ref1", "ref2"):
            state.add_node(CanvasNode(
                id=node_id, type="image", x=0, y=0, width=256, height=256,
                image_url="https://example.invalid/ref.png",
            ))
        store.save_canvas(state)
        generator = OpenAIImageGenerator(api_key="test-only", base_url="https://example.invalid/v1")
        error = "图片服务请求失败（HTTP 403）：Image service access was denied."
        before = store.get_canvas(state.canvas_id).to_dict()
        with patch.object(deps, "store", store), patch.object(deps.manager, "_generator", generator):
            for op, tool_name in (("generate", "generate_image"), ("variate", "variate_image"), ("compose", "compose_images")):
                with self.subTest(op=op), patch.object(
                    deps.tool_manager.get(tool_name), "run", side_effect=ValueError(error)
                ) as run:
                    response = self.client.post(f"/api/canvas/{state.canvas_id}/generate_stream", json={
                        "op": op, "prompt": "test", "node_id": "ref1", "node_ids": ["ref1", "ref2"],
                    })
                    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(events[-1], {"type": "done", "success": False, "message": error})
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(store.get_canvas(state.canvas_id).to_dict(), before)

    def test_models_connectivity_does_not_claim_image_generation_verified(self):
        response = requests.Response()
        response.status_code = 200
        response._content = b'{"data": [{"id": "test-image"}]}'
        with patch("app.api.routes.requests.Session.get", return_value=response) as get:
            result = self.client.post("/api/settings/test", json={
                "llm": {"provider": "mock"},
                "image": {"provider": "custom", "api_key": "test-only", "base_url": "https://example.invalid/v1", "model": "test-image"},
            }).json()["image"]
        self.assertTrue(result["ok"])
        self.assertIn("未验证生图权限或额度", result["message"])
        self.assertTrue(get.call_args.args[0].endswith("/models"))


if __name__ == "__main__":
    unittest.main()
