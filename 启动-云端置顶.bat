@echo off
chcp 65001 >nul 2>&1
title 元宝爱财 - 云端摸鱼浮窗（系统级置顶）
cd /d "%~dp0"

REM ============================================================
REM 云端统一数据模式：直接打开阿里云地址的「摸鱼浮窗」(?popup=1)
REM  - 数据走阿里云 server.js，与手机端完全一致（同一套数据体系）
REM  - 不启动本地 node server.js（本地无需代理，电脑端也纯云端）
REM  - 用 --app 无边框窗口 + 置顶.ps1 系统级钉在最前
REM  - 若日后域名/地址变更，只改下面这一行 URL 即可
REM ============================================================
set "URL=http://yangyuting.cloud/yuanbao/?popup=1"

REM 找 Chrome，用 --app 模式开成无边框独立浮窗
set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --app="%URL%" --window-size=420,760
) else (
  echo [警告] 未检测到 Chrome，改用系统默认浏览器打开
  start "" "%URL%"
)

REM 系统级置顶（Win API HWND_TOPMOST）：把标题含"元宝爱财"的窗口钉在最前
if exist "%~dp0置顶.ps1" (
  start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0置顶.ps1"
)
endlocal
