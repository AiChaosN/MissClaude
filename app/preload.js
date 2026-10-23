'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petHost', {
  init: () => ipcRenderer.invoke('pet:init'),
  cursor: () => ipcRenderer.invoke('pet:cursor'),
  moveTo: (x, y) => ipcRenderer.send('pet:move', x, y),
  rest: () => ipcRenderer.send('pet:rest'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', ignore),
  showMenu: () => ipcRenderer.send('pet:menu'),
  emit: (type, data) => ipcRenderer.send('pet:event', type, data),
  onCommand: (fn) => ipcRenderer.on('pet:command', (_e, cmd) => fn(cmd)),
});
