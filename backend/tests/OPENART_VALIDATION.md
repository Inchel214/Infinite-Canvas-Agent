# OpenArt canvas source — 2026-11-13

Scope: add a source selector to the existing image settings; keep API provider,
key, URL, normal model and streaming model in their existing fields. Store the
OpenArt source/model separately. No canvas, collection, clipboard, layout,
chat, existing API generator or MCP code changed in this task.

Use: Settings → 图片生成模型 → 生图来源 → OpenArt → select a model → save.
Switch back to 原有 API to restore the existing API generation path. Existing
settings without a source field default to API. Existing data is not migrated.

Verification:

- Six isolated backend tests passed: old API settings and masked-key roundtrip;
  restart persistence and switch-back; model filtering and login errors;
  simulated generation through the real canvas SSE endpoint and stored image;
  reference image conversion, multi-image composition and mask rejection;
  timeout without retry and delivery of the error to the container.
- Frontend TypeScript check passed. Scoped lint reported only the pre-existing
  unnecessary escape at SettingsPanel.tsx:261.
- Browser: opened the existing settings UI, switched to OpenArt, successfully
  checked the real logged-in account and saved the setting on an isolated canvas.
  Used the existing image container to submit exactly one real test generation.
- Live generation failed at the OpenArt generate endpoint while awaiting response
  headers. No retry was submitted. The follow-up read-only history request failed
  certificate verification (certificate for another domain), so generation/credit
  status could not be established. TLS checks were not bypassed. A fully successful
  paid generation and image-to-image call remain unverified.

Current CLI limitations: canvas size/resolution settings are not forwarded
(CLI uses model defaults); no mask support; no streaming image previews.
The settings UI describes size/mask limitations. Existing API remains available.
No new animation or visual redesign was added.

Run isolated tests (set CANVAS_DATA_DIR before importing app modules):

```sh
task_test_dir=$(mktemp -d /tmp/canvas-openart-tests.XXXXXX)
CANVAS_DATA_DIR="$task_test_dir/canvases" CANVAS_AUTH_TOKEN='' PYTHONPATH=backend \
  backend/.venv/bin/python -m unittest discover -s backend/tests -v
```
