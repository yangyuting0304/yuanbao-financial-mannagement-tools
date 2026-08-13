'use strict';
/*
 * main.js — 摸鱼理财 Electron 主进程
 * 功能：置顶小窗、系统托盘（仅托盘常驻，最隐蔽）、定时刷新、配置读写。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { fetchAll } = require('./datafeed');

const CONFIG_PATH = path.join(__dirname, 'config.json');
let win = null;
let tray = null;
let config = null;
let lastData = null;
let refreshTimer = null;
let willQuit = false;

// ---------- 配置读写 ----------
function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    config = { refreshSeconds: 5, domesticGold: { secid: '113.Au99.99', fxSecid: '119.USDCNY', fallbackUsdCny: 7.25 }, watchlist: [] };
  }
}
function saveConfig(cfg) {
  config = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------- 托盘图标（运行时生成金色圆点 PNG，无外部文件依赖） ----------
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function createIcon(size = 32) {
  const w = size, h = size;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const cx = w / 2 - 0.5, cy = h / 2 - 0.5, r = w / 2 - 3;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // 过滤器：无
    for (let x = 0; x < w; x++) {
      const i = y * (w * 4 + 1) + 1 + x * 4;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        raw[i] = 255; raw[i + 1] = 193; raw[i + 2] = 7; raw[i + 3] = 255; // 金色 #FFC107
      } else {
        raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0; // 透明
      }
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 326,
    height: 540,
    minWidth: 280,
    minHeight: 200,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true, // 仅托盘可见，最隐蔽
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  win.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    // 默认贴右下角
    const { width: ww, height: wh } = win.getBounds();
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    win.setPosition(Math.max(0, sw - ww - 16), Math.max(0, sh - wh - 16));
    if (lastData) win.webContents.send('tick', decorate(lastData));
  });

  // 点 X / 关闭：隐藏到托盘而非退出
  win.on('close', (e) => {
    if (!willQuit) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  try {
    const icon = nativeImage.createFromBuffer(createIcon(32));
    tray = new Tray(icon);
    const menu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏窗口', click: () => toggleWindow() },
      { label: '立即刷新', click: () => doRefresh() },
      { type: 'separator' },
      { label: '退出摸鱼理财', click: () => { willQuit = true; app.quit(); } },
    ]);
    tray.setToolTip('摸鱼理财 · 盯盘');
    tray.setContextMenu(menu);
    tray.on('click', () => toggleWindow());
  } catch (e) {
    console.error('托盘创建失败：', e);
  }
}
function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
}

// ---------- 刷新循环 ----------
function decorate(data) {
  // 给每条数据附加显示用方向标记，渲染进程直接使用
  const items = {};
  for (const [code, d] of Object.entries(data.items)) {
    const dir = d.change == null ? 0 : d.change > 0 ? 1 : d.change < 0 ? -1 : 0;
    items[code] = { ...d, dir };
  }
  return { ...data, items };
}
async function doRefresh() {
  try {
    const data = await fetchAll(config);
    lastData = data;
    if (win && win.isVisible()) win.webContents.send('tick', decorate(data));
    else if (win) win.webContents.send('tick', decorate(data)); // 即便隐藏也更新缓存
  } catch (e) {
    // 保留上一次成功数据
    console.error('refresh error:', e.message);
  }
}
function startTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  const sec = Math.max(2, Math.floor(config.refreshSeconds || 5));
  refreshTimer = setInterval(doRefresh, sec * 1000);
}

// ---------- IPC ----------
ipcMain.handle('get-state', () => ({ config, data: lastData ? decorate(lastData) : null }));
ipcMain.handle('get-config', () => config);
ipcMain.handle('refresh-now', async () => { await doRefresh(); return 'ok'; });
ipcMain.handle('save-config', (_e, cfg) => {
  saveConfig(cfg);
  startTimer();
  doRefresh();
  return 'ok';
});
ipcMain.handle('toggle-top', () => {
  if (!win) return false;
  const on = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(on, 'screen-saver');
  return on;
});
ipcMain.handle('is-top', () => (win ? win.isAlwaysOnTop() : false));
ipcMain.on('minimize', () => win && win.minimize());
ipcMain.on('hide', () => win && win.hide());

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  loadConfig();
  createWindow();
  createTray();
  startTimer();
  doRefresh();
});

app.on('before-quit', () => { willQuit = true; });
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
