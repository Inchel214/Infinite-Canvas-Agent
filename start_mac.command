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

# ===== 4. 后端依赖（venv 隔离，不污染系统）=====
info "准备后端环境..."
cd backend
if [[ ! -d .venv ]]; then
  info "首次运行：创建 Python 虚拟环境..."
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt
ok "后端依赖就绪"
deactivate
cd ..

# ===== 5. 前端依赖 =====
info "准备前端环境..."
cd frontend
if [[ ! -d node_modules ]]; then
  info "首次运行：安装前端依赖（可能需要 1-2 分钟）..."
  npm install
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

# ===== 7. 启动服务 =====
info "启动服务中..."
cleanup() {
  echo ""
  warn "正在停止所有服务..."
  [[ -n "$BACKEND_PID" ]]  && kill "$BACKEND_PID"  2>/dev/null
  [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# 后端
cd backend
source .venv/bin/activate
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!
deactivate
cd ..

# 前端
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

# 等待服务就绪后打开浏览器
info "等待服务启动..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null http://127.0.0.1:8000/api/canvas 2>/dev/null; then
    break
  fi
  sleep 1
done
sleep 2
if ! open http://localhost:5173; then
  warn "无法自动打开默认浏览器，请手动访问 http://localhost:5173"
fi

echo ""
ok "=========================================="
ok "  启动完成！"
ok "=========================================="
echo ""
echo "  前端页面:  http://localhost:5173"
echo "  后端接口:  http://127.0.0.1:8000"
echo ""
warn "  按 Ctrl+C 停止所有服务"
echo ""

wait
