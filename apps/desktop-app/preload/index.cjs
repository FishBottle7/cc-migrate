/**
 * preload — contextBridge 暴露唯一的 window.api。
 * 纯 CJS（.cjs），Electron 直接加载，无需构建。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listTools: () => ipcRenderer.invoke('tools:list'),
  listSessions: (tool, root) => ipcRenderer.invoke('sessions:list', { tool, root }),
  preview: (tool, sessionId, root) =>
    ipcRenderer.invoke('session:preview', { tool, sessionId, root }),
  migrate: (params) => ipcRenderer.invoke('migrate:run', params),
  pickDirectory: (defaultPath) => ipcRenderer.invoke('dialog:pick-dir', { defaultPath }),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  versions: () => ipcRenderer.invoke('app:versions'),
});
