@echo off
chcp 65001 >nul 2>&1
title 🐱 元宝爱财 - 数据代理服务
echo.
echo   ╔════════════════════════════════╗
echo   ║   🐱 元宝爱财 启动中...       ║
echo   ╚════════════════════════════════╝
echo.

:: 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js！请先安装 Node.js: https://nodejs.org/
  echo 安装后重新运行此文件即可。
  pause
  exit /b 1
)

:: 切换到脚本所在目录（确保能找到 server.js 和 html）
cd /d "%~dp0"

:: 启动数据代理服务（后台运行）
start "元宝爱财-数据服务" /min cmd /c "node server.js"

:: 等待服务启动
echo 正在启动数据服务...
timeout /t 2 /nobreak >nul

:: 查找 Chrome 并以 app 模式打开
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if defined CHROME (
  start "" "%CHROME%" --app="http://localhost:18765" --window-size=350,800
) else (
  :: 回退：尝试默认打开
  start http://localhost:18765
)

echo.
echo   ✅ 服务已启动！浏览器窗口即将打开。
echo   💡 关闭浏览器后，此命令行窗口按 Ctrl+C 可停止数据服务。
echo.
