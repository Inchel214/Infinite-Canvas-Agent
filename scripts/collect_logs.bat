@echo off
rem Windows launcher: double-click to pack all logs into a zip in the project root.
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."
set "PY="

if exist "%ROOT%\backend\.venv\Scripts\python.exe" set "PY=%ROOT%\backend\.venv\Scripts\python.exe"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

if not defined PY (
  echo [ERROR] Python 3 not found. Install Python 3 or set up backend\.venv first.
  pause
  exit /b 1
)

%PY% "%~dp0collect_logs.py"
echo.
pause
