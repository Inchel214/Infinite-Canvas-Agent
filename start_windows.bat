@echo off
chcp 65001 >nul
title Infinite-Canvas-Agent 启动器
cd /d "%~dp0"

echo.
echo ==========================================
echo   Infinite-Canvas-Agent 一键启动 (Windows)
echo ==========================================
echo.

REM ===== 1. 检查 Node.js =====
where node >nul 2>nul
if %errorlevel%==0 (
    echo [OK] Node: & node --version
) else (
    echo [缺] 未检测到 Node.js，尝试自动安装...
    where winget >nul 2>nul
    if not %errorlevel%==0 goto NEED_NODE
    winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if not %errorlevel%==0 goto NEED_NODE
    echo [提示] Node.js 已安装，请关闭本窗口后重新双击运行
    pause & exit /b 1
    :NEED_NODE
    echo.
    echo 请手动安装 Node.js（LTS 版）后重新双击本脚本：
    echo   https://nodejs.org/zh-cn/download
    echo.
    pause & exit /b 1
)

REM ===== 2. 检查 Python =====
set "PYCMD="
py -3 -V >nul 2>nul && set "PYCMD=py -3"
if not defined PYCMD (
    python -V >nul 2>nul && set "PYCMD=python"
)
if defined PYCMD goto PY_OK

echo [缺] 未检测到 Python，尝试自动安装...
where winget >nul 2>nul
if not %errorlevel%==0 goto NEED_PY
winget install --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
if not %errorlevel%==0 goto NEED_PY
echo [提示] Python 已安装，请关闭本窗口后重新双击运行
pause & exit /b 1
:NEED_PY
echo.
echo 请手动安装 Python 3.10+ 后重新双击本脚本：
echo   https://www.python.org/downloads/windows/
echo （安装时勾选 "Add Python to PATH"）
echo.
pause & exit /b 1
:PY_OK
echo [OK] Python 就绪

REM ===== 3. 清理占用 8000/5173 端口的旧进程（无论之前是 bat 启动还是手动启动）=====
echo 检查并清理占用 8000/5173 端口的旧进程...
powershell -NoProfile -Command "foreach ($port in @(8000, 5173)) { $conns = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue; if ($conns) { foreach ($c in $conns) { $proc = Get-Process -Id $c.OwningProcess -EA SilentlyContinue; if ($proc) { Write-Host ('  已清理端口 ' + $port + ' 上的进程 ' + $proc.Name + ' (PID ' + $proc.Id + ')'); Stop-Process -Id $proc.Id -Force } } } }"

REM ===== 4. 后端环境（venv 隔离，不污染系统）=====
echo 准备后端环境...
cd /d "%~dp0backend"
if not exist .venv (
    echo 首次运行：创建 Python 虚拟环境...
    %PYCMD% -m venv .venv
    if not exist .venv\Scripts\python.exe (
        echo [错误] 虚拟环境创建失败，请检查 Python 安装
        pause & exit /b 1
    )
)
echo 检查/安装后端依赖（首次可能需要几分钟）...
.venv\Scripts\python -m pip install --upgrade pip -q --disable-pip-version-check
.venv\Scripts\python -m pip install -r requirements.txt -q --disable-pip-version-check
if not %errorlevel%==0 (
    echo [错误] 后端依赖安装失败，请检查网络后重试
    pause & exit /b 1
)
echo [OK] 后端依赖就绪
cd /d "%~dp0"

REM ===== 5. 前端依赖（每次运行：依赖齐全时几秒完成，更新后自动补装）=====
echo 准备前端环境...
cd /d "%~dp0frontend"
call npm install --no-fund --no-audit
if not %errorlevel%==0 (
    echo [错误] 前端依赖安装失败，请检查网络后重试
    pause & exit /b 1
)
echo [OK] 前端依赖就绪
cd /d "%~dp0"

REM ===== 6. API Key 配置（可选，跳过则用演示模式）=====
if exist backend\.env goto KEY_DONE
echo.
echo 检测到未配置 API Key
echo   - 配置后可调用豆包 Seedream 真实生图 API
echo   - 直接回车跳过，将使用演示模式（生成占位图，无需联网）
echo.
set "api_key="
set /p "api_key=请输入 ARK_API_KEY（可留空跳过）: "
if "%api_key%"=="" goto KEY_SKIP
> backend\.env echo ARK_API_KEY=%api_key%
echo [OK] API Key 已保存到 backend\.env
goto KEY_DONE
:KEY_SKIP
echo 已跳过，使用演示模式
:KEY_DONE

REM ===== 7. 启动服务（两个独立窗口，关闭窗口即停止服务）=====
echo.
echo 启动服务中...
cd /d "%~dp0backend"
start "InfiniteCanvas-后端" cmd /k ".venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
cd /d "%~dp0frontend"
start "InfiniteCanvas-前端" cmd /k "npm run dev"
cd /d "%~dp0"

REM ===== 8. 等待后端就绪后打开浏览器 =====
echo 等待服务启动（最多 45 秒）...
powershell -NoProfile -Command "for($i=0; $i -lt 45; $i++){ try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/canvas -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep 1 } }"
start "" http://localhost:5173

echo.
echo ==========================================
echo   启动完成！
echo ==========================================
echo.
echo   前端页面:  http://localhost:5173
echo   后端接口:  http://127.0.0.1:8000
echo.
echo   停止服务：关闭"InfiniteCanvas-后端"和"InfiniteCanvas-前端"两个窗口
echo   下次使用：直接双击本脚本即可（会自动跳过已完成的安装步骤）
echo.
pause
