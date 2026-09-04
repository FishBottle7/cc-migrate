/**
 * Electron 主进程入口：窗口 + IPC 注册。
 * 渲染进程 contextIsolation，一切 Node/core 调用都经 ipcMain.handle。
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPreview, listToolSessions, listTools, runMigrate, shutdownWorker } from './backend.js';
import type { MigrateParams } from './ipc-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// rootDir=src/main → 主进程产物平铺在 dist/：preload 在 <app>/preload，渲染层在 dist/renderer
const PRELOAD = path.resolve(__dirname, '../preload/index.cjs');
const RENDERER = path.join(__dirname, 'renderer', 'index.html');

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#ffffff',
    title: 'cc-migrate',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      // preload 以 .cjs 直接加载源文件，无需构建步骤
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', details.reason, 'exitCode=', details.exitCode);
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(RENDERER);
  }
}

function registerIpc(): void {
  ipcMain.handle('tools:list', () => listTools());

  ipcMain.handle('sessions:list', (_e, p: { tool: string; root?: string }) =>
    listToolSessions(p.tool, p.root));

  ipcMain.handle('session:preview', (_e, p: { tool: string; sessionId: string; root?: string }) =>
    buildPreview(p.tool, p.sessionId, p.root));

  ipcMain.handle('migrate:run', (_e, p: MigrateParams) => runMigrate(p));

  ipcMain.handle('dialog:pick-dir', async (_e, p: { defaultPath?: string }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: p?.defaultPath,
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('shell:open-path', async (_e, p: string) => {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) await shell.openPath(p);
      else shell.showItemInFolder(p);
    } catch {
      // 路径已不存在时静默忽略
    }
  });

  ipcMain.handle('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));
}

app.disableHardwareAcceleration(); // 纯表单类 UI：软件渲染更稳，规避 GPU 驱动闪退

// SM_SMOKE=1：不开窗口，主进程自检「解析 → DTO」整条链路后退出（诊断用）
if (process.env.SM_SMOKE) {
  app.whenReady().then(async () => {
    const step = (s: string) => console.error(`[smoke] ${s} rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
    try {
      step('requesting preview via worker');
      const smokeId = process.env.SM_SMOKE && process.env.SM_SMOKE.length > 1 ? process.env.SM_SMOKE : 'session-c097d57d-dd84-4b34-a3b3-32f3a20a65a6';
      const t0 = Date.now();
      const p = await buildPreview('dsh', smokeId);
      step(`preview ok ms=${Date.now() - t0} messages=${p.messages.length}`);
      const dto = JSON.stringify(p.messages);
      step(`dto chars=${dto.length}`);
    } catch (e) {
      console.error('[smoke] FAILED', e);
      app.exit(1);
      return;
    }
    app.exit(0);
  });
} else {
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'light';
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    shutdownWorker();
    app.quit();
  });
}
