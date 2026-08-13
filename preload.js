'use strict';
/*
 * preload.js — 安全桥接：仅向渲染进程暴露必要接口（contextIsolation 开启）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moyu', {
  // 主进程 → 渲染进程：每次刷新推送最新行情
  onTick: (cb) => ipcRenderer.on('tick', (_e, d) => cb(d)),
  // 初始化：拿到配置与首屏数据
  getState: () => ipcRenderer.invoke('get-state'),
  // 渲染进程 → 主进程
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getConfig: () => ipcRenderer.invoke('get-config'),
  minimize: () => ipcRenderer.send('minimize'),
  hide: () => ipcRenderer.send('hide'),
  toggleTop: () => ipcRenderer.invoke('toggle-top'),
  isTop: () => ipcRenderer.invoke('is-top'),
});
