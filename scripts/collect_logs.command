#!/bin/bash
# macOS 双击运行：打包全部日志到项目根目录，生成 logs_时间戳.zip
# 首次使用若提示权限不足，执行一次：chmod +x scripts/collect_logs.command
cd "$(dirname "$0")/.." || exit 1

PY=""
if [ -x "backend/.venv/bin/python" ]; then
  PY="backend/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
fi

if [ -z "$PY" ]; then
  echo "未找到 Python 3，请先安装：https://www.python.org/downloads/"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

"$PY" "scripts/collect_logs.py"
status=$?
echo
read -n 1 -s -r -p "按任意键退出..."
exit $status
