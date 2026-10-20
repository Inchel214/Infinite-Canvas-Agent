#!/bin/bash
# Infinite-Canvas-Agent macOS 一键启动脚本
# 用法：双击此文件，或在终端运行 bash start_mac.command
# 首次运行会自动安装 Homebrew / Python / Node（需要输入电脑密码）
# 没有 ARK API Key 也能直接体验（后端自动降级为演示模式）

set -e
cd "$(dirname "$0")"

# Prefer the project-local Node runtime when present. This avoids relying on an
# older system Node and keeps npm's cache out of a potentially unwritable home cache.
LOCAL_NODE_DIR="$PWD/.runtime/node-v22.20.0-darwin-x64/bin"
if [[ -x "$LOCAL_NODE_DIR/node" ]]; then
  export PATH="$LOCAL_NODE_DIR:$PATH"
fi
export npm_config_cache="$PWD/.npm-cache"

# 终端颜色
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'
info()  { echo -e "${CYAN}$1${NC}"; }
ok()    { echo -e "${GREEN}$1${NC}"; }
warn()  { echo -e "${YELLOW}$1${NC}"; }

echo ""
info "=========================================="
info "  Infinite-Canvas-Agent 一键启动 (macOS)"
info "=========================================="
echo ""

# ===== 1. Homebrew（macOS 软件包管理器，没有则自动安装）=====
if ! command -v brew >/dev/null 2>&1; then
  warn "未检测到 Homebrew，开始自动安装（弹出提示时按回车，并输入电脑密码）..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # 让 brew 在当前 shell 可用（兼容 Apple Silicon 和 Intel）
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  ok "Homebrew 安装完成"
else
  ok "Homebrew 已安装"
fi

# ===== 2. Python 3 =====
if ! command -v python3 >/dev/null 2>&1; then
  info "正在安装 Python 3..."
  brew install python@3
fi
ok "Python: $(python3 --version)"

# ===== 3. Node.js =====
if ! command -v node >/dev/null 2>&1; then
  info "正在安装 Node.js..."
  brew install node
fi
ok "Node: $(node --version)"

# ===== 4. 后端依赖（仅在首次或依赖清单变化时安装）=====
info "准备后端环境..."
cd backend
if [[ ! -d .venv ]]; then
  info "首次运行：创建 Python 虚拟环境..."
  python3 -m venv .venv
fi
BACKEND_DEPS_HASH="$(shasum -a 256 requirements.txt | awk '{print $1}')"
BACKEND_STAMP="$PWD/.venv/.requirements.sha256"
if [[ ! -x .venv/bin/python ]] || [[ ! -f "$BACKEND_STAMP" ]] || [[ "$(<"$BACKEND_STAMP")" != "$BACKEND_DEPS_HASH" ]]; then
  info "检测到后端依赖需要更新..."
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
  echo "$BACKEND_DEPS_HASH" > "$BACKEND_STAMP"
else
  ok "后端依赖未变化，跳过安装"
fi
ok "后端依赖就绪"
cd ..

# ===== 5. 前端依赖（仅在首次或锁定文件变化时安装）=====
info "准备前端环境..."
cd frontend
FRONTEND_DEPS_HASH="$(shasum -a 256 package.json package-lock.json | shasum -a 256 | awk '{print $1}')"
FRONTEND_STAMP="$PWD/node_modules/.dependencies.sha256"
if [[ ! -d node_modules ]] || [[ ! -f "$FRONTEND_STAMP" ]] || [[ "$(<"$FRONTEND_STAMP")" != "$FRONTEND_DEPS_HASH" ]]; then
  info "检测到前端依赖需要更新（首次可能需要 1-2 分钟）..."
  npm install
  echo "$FRONTEND_DEPS_HASH" > "$FRONTEND_STAMP"
else
  ok "前端依赖未变化，跳过安装"
fi
ok "前端依赖就绪"
cd ..

# ===== 6. API Key 配置（可选，跳过则用演示模式）=====
if [[ ! -f backend/.env ]]; then
  echo ""
  warn "检测到未配置 API Key"
  echo "  - 配置后可调用豆包 Seedream 真实生图 API"
  echo "  - 直接回车跳过，将使用演示模式（生成 SVG 占位图）"
  echo ""
  printf "请输入 ARK_API_KEY（可留空跳过）: "
  read -r api_key
  # 去除前后空白（粘贴时常见带空格/换行）
  api_key="$(echo -n "$api_key" | xargs)"
  if [[ -n "$api_key" ]]; then
    echo "ARK_API_KEY=$api_key" > backend/.env
    ok "API Key 已保存到 backend/.env"
    # 验证写入
    if grep -q "ARK_API_KEY=" backend/.env; then
      ok "配置验证通过，将使用真实生图 API"
    else
      warn "配置文件写入异常，将使用演示模式"
    fi
  else
    warn "已跳过，使用演示模式"
  fi
  echo ""
fi

# ===== 7. 停止占用 8000/5173 端口的旧服务 =====
info "正在停止旧的画布前后端..."
for port in 8000 5173; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      pname="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
      warn "  停止端口 $port 上的 ${pname:-进程} (PID $pid)"
      kill -TERM "$pid" 2>/dev/null || true
    done
  fi
done

# 给旧服务一点时间正常退出；超时后再强制释放端口。
for _ in $(seq 1 20); do
  remaining="$(
    { lsof -tiTCP:8000 -sTCP:LISTEN 2>/dev/null || true; lsof -tiTCP:5173 -sTCP:LISTEN 2>/dev/null || true; } |
      sort -u
  )"
  [[ -z "$remaining" ]] && break
  sleep 0.1
done
if [[ -n "${remaining:-}" ]]; then
  warn "  旧服务未及时退出，正在强制停止..."
  for pid in $remaining; do
    kill -KILL "$pid" 2>/dev/null || true
  done
fi

# ===== 8. 启动服务（一个窗口两个页签）=====
info "启动服务中..."
PROJECT_DIR="$(pwd)"

# 使用 AppleScript 在 Terminal.app 中打开一个窗口 + 两个页签
osascript <<APPLESCRIPT
tell application "Terminal"
    -- 先关闭当前脚本所在的终端窗口（避免重复）
    set alreadyOpen to (count of windows)

    -- 第一个页签：后端
    do script "cd '${PROJECT_DIR}/backend' && source .venv/bin/activate && python -m uvicorn app.main:app --host 127.0.0.1 --port 8000"

    -- 第二个页签：前端
    tell application "System Events" to keystroke "t" using {command down}
    delay 0.5
    do script "cd '${PROJECT_DIR}/frontend' && npm run dev" in window 1

    -- 设置窗口标题
    set custom title of window 1 to "InfiniteCanvas-后端 | 前端"
end tell
APPLESCRIPT

# 等待前后端都就绪。不自动打开浏览器，避免切换或新建页签。
info "等待服务启动..."
SERVICES_READY=0
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:8000/api/providers 2>/dev/null &&
     curl -fsS -o /dev/null http://localhost:5173/ 2>/dev/null; then
    SERVICES_READY=1
    break
  fi
  sleep 1
done
if [[ "$SERVICES_READY" -ne 1 ]]; then
  warn "服务启动超时，请查看上方日志"
  exit 1
fi

echo ""
ok "=========================================="
ok "  启动完成！"
ok "=========================================="
echo ""
echo "  前端页面:  http://localhost:5173"
echo "  后端接口:  http://127.0.0.1:8000"
echo "  浏览器:    保持当前页签，刷新即可继续使用"
echo ""
warn "  服务已在 Terminal.app 的一个窗口（两个页签）中运行"
warn "  关闭该窗口即可停止所有服务"
echo ""
