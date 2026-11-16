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
REM Vite 8 需要 Node 22+：更早的 20.x 没有 node:util 的 styleText 导出，
REM 会直接报 "does not provide an export named 'styleText'" 而无法启动
set "NODEMAJOR="
where node >nul 2>nul
if not %errorlevel%==0 goto NEED_NODE
for /f "tokens=1 delims=." %%a in ('node -v 2^>nul') do set "NODEMAJOR=%%a"
if defined NODEMAJOR set "NODEMAJOR=%NODEMAJOR:~1%"
if not defined NODEMAJOR goto NEED_NODE
if %NODEMAJOR% GEQ 22 goto NODE_OK

echo [警告] 检测到 Node.js v%NODEMAJOR%.x，Vite 8 需要 Node 22 及以上
echo         该版本会启动失败：node:util 未导出 styleText
where winget >nul 2>nul
if not %errorlevel%==0 goto NEED_NODE
echo 尝试自动升级 Node.js...
winget install --id OpenJS.NodeJS.LTS --source winget --silent --accept-source-agreements --accept-package-agreements
if not %errorlevel%==0 goto NEED_NODE
echo [提示] Node.js 已升级，请关闭本窗口后重新双击运行
pause & exit /b 1

:NEED_NODE
echo.
echo 请安装 Node.js 22 LTS 或更高版本后重新双击本脚本：
echo   https://nodejs.org/zh-cn/download
echo.
pause & exit /b 1
:NODE_OK
echo [OK] Node: & node --version

REM ===== 2. 检查 Python =====
REM 只接受 3.10-3.12：requirements.txt 里固定的 pydantic-core / Pillow 版本
REM 没有 3.13+ 的预编译 wheel，用 3.13/3.14 会退化成源码编译（需 Rust + crates.io），
REM 在受限网络下必然失败（表现为 "maturin failed / failed to load source for ahash"）
set "PYCMD="
for %%v in (3.12 3.11 3.10) do (
    if not defined PYCMD (
        py -%%v -V >nul 2>nul
        if not errorlevel 1 set "PYCMD=py -%%v"
    )
)
if defined PYCMD goto PY_OK

echo [缺] 未检测到兼容的 Python（需要 3.10-3.12），尝试自动安装 Python 3.12...
where winget >nul 2>nul
if not %errorlevel%==0 goto NEED_PY
winget install --id Python.Python.3.12 --source winget --silent --accept-source-agreements --accept-package-agreements
if not %errorlevel%==0 goto NEED_PY
echo [提示] Python 3.12 已安装，请关闭本窗口后重新双击运行
pause & exit /b 1
:NEED_PY
echo.
echo 请手动安装 Python 3.12 后重新双击本脚本：
echo   https://www.python.org/downloads/release/python-31210/
echo （安装时勾选 "Add Python to PATH"）
echo.
pause & exit /b 1
:PY_OK
%PYCMD% -V

REM ===== 3. 清理占用 8000/5173 端口的旧进程（无论之前是 bat 启动还是手动启动）=====
echo 检查并清理占用 8000/5173 端口的旧进程...
powershell -NoProfile -Command "foreach ($port in @(8000, 5173)) { $conns = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue; if ($conns) { foreach ($c in $conns) { $proc = Get-Process -Id $c.OwningProcess -EA SilentlyContinue; if ($proc) { Write-Host ('  已清理端口 ' + $port + ' 上的进程 ' + $proc.Name + ' (PID ' + $proc.Id + ')'); Stop-Process -Id $proc.Id -Force } } } }"

REM ===== 4. 后端环境（venv 隔离，不污染系统）=====
echo 准备后端环境...
cd /d "%~dp0backend"
REM 已有 .venv 但可能是旧版 Python 建的（如 3.14）→ 版本不兼容，重建
set "VENVVER="
if exist .venv\Scripts\python.exe (
    for /f "tokens=2 delims= " %%a in ('.venv\Scripts\python.exe -V 2^>nul') do set "VENVVER=%%a"
)
if defined VENVVER set "VENVVER=%VENVVER:~0,4%"
if defined VENVVER (
    if not "%VENVVER%"=="3.10" if not "%VENVVER%"=="3.11" if not "%VENVVER%"=="3.12" (
        echo [提示] 现有虚拟环境是 Python %VENVVER%，与固定依赖不兼容，将自动重建...
        set "VENVVER="
    )
)
if not defined VENVVER (
    echo 创建 Python 虚拟环境...
    %PYCMD% -m venv --clear .venv
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

REM ===== 7. 启动服务（一个窗口两个页签）=====
REM 监听 0.0.0.0：本机用 localhost 访问，同一局域网的平板/手机用本机 IP 访问
echo.
echo 启动服务中...
set "BACKEND_DIR=%~dp0backend"
set "FRONTEND_DIR=%~dp0frontend"

where wt >nul 2>nul
if %errorlevel%==0 (
    REM Windows Terminal 可用：一个窗口，两个页签
    wt --title "InfiniteCanvas-后端" --startingDirectory "%BACKEND_DIR%" -- cmd /k "%BACKEND_DIR%\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
    timeout /t 1 /nobreak >nul
    wt new-tab --title "InfiniteCanvas-前端" --startingDirectory "%FRONTEND_DIR%" -- cmd /k "cd /d %FRONTEND_DIR% && npm run dev"
) else (
    echo [提示] Windows Terminal 未安装，使用传统双窗口模式
    cd /d "%BACKEND_DIR%"
    start "InfiniteCanvas-后端" cmd /k ".venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
    cd /d "%FRONTEND_DIR%"
    start "InfiniteCanvas-前端" cmd /k "npm run dev"
)
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
REM 取本机局域网 IPv4，供平板/手机在同一 WiFi 下访问
set "LANIP="
set "LANIP_FILE=%TEMP%\ica_lan_ip.txt"
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress" > "%LANIP_FILE%" 2>nul
if exist "%LANIP_FILE%" set /p LANIP=<"%LANIP_FILE%"
if defined LANIP (
    echo.
    echo   局域网访问（平板/手机连同一 WiFi）:  http://%LANIP%:5173
    echo   如果平板打不开：检查 Windows 防火墙是否放行 5173/8000 端口
) else (
    echo.
    echo   [提示] 未取到局域网 IP，平板访问需手动查看本机 IP（ipconfig）
)
echo.
echo   停止服务：关闭"InfiniteCanvas-后端"和"InfiniteCanvas-前端"两个窗口
echo   下次使用：直接双击本脚本即可（会自动跳过已完成的安装步骤）
echo.
pause
