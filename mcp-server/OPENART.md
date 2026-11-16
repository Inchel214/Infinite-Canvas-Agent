# OpenArt → MCP → Infinite Canvas

Installed on 2026-11-13: official OpenArt CLI 0.1.1 (darwin/arm64), SHA-256 verified.
Source: https://github.com/OpenArt-AI/cli

The vendor supplies a CLI, not an MCP server. `openart_server.py` is a local
adapter. It runs the CLI without a shell and uses the canvas's existing image
upload endpoint; it does not alter the canvas UI or its default image provider.

## Login

Double-click `openart-login.command` in the project root and complete the browser
login. Credentials remain in the CLI's `~/.openart/cli-credentials.json`; no key
belongs in this repository or in MCP configuration.

## Tools

- `openart_account`: check login, plan and balance.
- `openart_models`: discover current model IDs.
- `openart_model_info`: inspect input schema and estimated credits.
- `openart_generate_image`: defaults to `dry_run=True`; `False` submits a paid
  generation and downloads results under `.runtime/openart/outputs/`.
  Local reference images are uploaded to OpenArt during live generation.
- `openart_list_canvases`: find the target canvas ID.
- `openart_import_image`: import a downloaded result, retaining its aspect ratio.

Start the canvas normally before listing/importing. Inspect the destination and
pick coordinates before import. A failed import can be retried using the saved
file without regenerating. If generation times out, inspect OpenArt creation
history before resubmitting to avoid duplicate charges.

## MCP configuration

The local stdio server runs with `mcp-server/.venv/bin/python` and
`mcp-server/openart_server.py`. Its dependencies are in `requirements.txt`.
Set `OPENART_CLI` or `CANVAS_API_BASE` to override the default binary/API paths.
Give this server `tool_timeout_sec = 360` to accommodate image generation.

After changing MCP configuration, reload the client connection or restart Codex
if tools are not yet visible. Newly configured tools may not enter an existing
chat's tool catalog immediately.

## Validation boundary

Installation, CLI request preview, stdio MCP discovery and local image import
can be checked without spending credits. Live OpenArt generation requires login
and a separate user request to generate an image; installation itself does not
authorize a charge.

Verified on 2026-11-13 with `mcp-server/.venv/bin/python
mcp-server/test_openart_mcp.py`: all six tools discovered over real MCP stdio,
real CLI dry-run (including a prompt beginning with `--`), isolated backend
canvas listing and image import with preserved aspect ratio and coordinates,
and rejection of imports outside the adapter output directory. No credits spent.
Global Codex server name: `openart`; tool timeout: 360 seconds.

The user completed browser authorization on 2026-11-13. The adapter then read
the account successfully and discovered 41 model entries, including
`gpt-image-2` and `nano-banana-2`. Live generation remains untested.
