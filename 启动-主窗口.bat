@echo off
chcp 65001 >nul 2>&1
title 元宝爱财 - 摸鱼盯盘（主窗口 / 可切独立浮窗）
cd /d "%~dp0"

REM 主窗口模式：打开普通浏览器窗口，页面内提供「独立浮窗」按钮
set "URL=http://localhost:18765"

REM 检查 18765 端口是否已在监听（代理服务是否在跑）
netstat -an | findstr ":18765" >nul 2>&1
if errorlevel 1 (
  REM 未监听：检查 Node.js 并启动代理
  where node >nul 2>&1
  if errorlevel 1 (
    echo [警告] 未检测到 Node.js，降级为 file:// 直接打开（国内金价可能不准确）
    set "URL=file:///%~dp0元宝爱财-摸鱼致富.html"
  ) else (
    echo 正在启动数据代理服务（node server.js）...
    start "元宝爱财-数据服务" /min cmd /c "node server.js"
    timeout /t 2 /nobreak >nul
  )
) else (
  echo [OK] 数据代理服务已在 18765 运行
)

REM 找 Chrome，用普通窗口打开（保留地址栏，可切独立浮窗）
set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" "%URL%"
) else (
  start "" "%URL%"
)
endlocal
