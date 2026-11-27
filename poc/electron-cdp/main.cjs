const { app, BrowserWindow, ipcMain, Menu } = require('electron');

let ipcCount = 0;

app.whenReady().then(() => {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ label: 'Safe Native Menu Item', click: () => {} }, { role: 'quit' }],
    },
  ]);
  Menu.setApplicationMenu(menu);

  ipcMain.handle('poc:mutate', () => {
    ipcCount += 1;
    process.stdout.write(`ELECTRON_IPC_CALLED count=${ipcCount}\n`);
    return { ipcCount };
  });

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const html = `<!doctype html>
<html>
  <head><title>Electron Phase 0 Fixture</title></head>
  <body>
    <button data-testid="renderer-btn" onclick="document.getElementById('out').textContent='renderer-clicked'">Renderer Safe Button</button>
    <button data-testid="ipc-btn" onclick="require('electron').ipcRenderer.invoke('poc:mutate').then(r => { document.getElementById('ipc-out').textContent = 'ipc-' + r.ipcCount; })">Trigger Main IPC</button>
    <p id="out">idle</p>
    <p id="ipc-out">no-ipc</p>
  </body>
</html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});
