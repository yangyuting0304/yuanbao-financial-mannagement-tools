@echo off
chcp 65001 >nul 2>&1
title 🐱 元宝爱财 - 摸鱼小窗（弹窗模式）
cd /d "%~dp0"

REM 直接以 ?popup=1 打开，即“弹窗模式”：页面应用紧凑样式、可自定义窗口大小
set "URL=http://localhost:18765/?popup=1"

REM 检查 18765 端口是否已在监听（代理服务是否在跑）
netstat -an | findstr ":18765" >nul 2>&1
if errorlevel 1 (
  REM 未监听：检查 Node.js 并启动代理
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

REM 找 Chrome，用 --app 模式开成无边框小窗（最像桌面软件、最隐蔽）
set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --app="%URL%" --window-size=400,760
) else (
  start "" "%URL%"
)
endlocal
