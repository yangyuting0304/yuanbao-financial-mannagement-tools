@echo off
chcp 65001 >nul 2>&1
title 元宝爱财 - 摸鱼盯盘（独立浮窗 + 系统级置顶）
cd /d "%~dp0"

REM 独立浮窗 + 置顶模式：URL 带 ?popup=1，打开后可拖拽缩放，再由置顶.ps1 钉在最前
set "URL=http://localhost:18765/?popup=1"

REM 检查 18765 端口是否已在监听
netstat -an | findstr ":18765" >nul 2>&1
if errorlevel 1 (
  where node >nul 2>&1
  if errorlevel 1 (
    echo [警告] 未检测到 Node.js，降级为 file:// 直接打开（国内金价可能不准确）
    set "URL=file:///%~dp0元宝爱财-摸鱼致富.html?popup=1"
  ) else (
    echo 正在启动数据代理服务（node server.js）...
    start "元宝爱财-数据服务" /min cmd /c "node server.js"
    timeout /t 2 /nobreak >nul
  )
) else (
  echo [OK] 数据代理服务已在 18765 运行
)

REM 找 Chrome，用 --app 模式开成无边框独立浮窗
set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --app="%URL%" --window-size=420,760
) else (
  start "" "%URL%"
)

REM 系统级置顶（Win API HWND_TOPMOST）：把标题含"元宝爱财"的窗口钉在最前
if exist "%~dp0置顶.ps1" (
  start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0置顶.ps1"
)
endlocal
