import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronBin = path.join(__dirname, 'node_modules', '.bin', 'electron');
const mainEntry = path.join(__dirname, 'main.cjs');

const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [mainEntry, '--remote-debugging-port=0'], {
  env: cleanEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ipcSawCall = false;
child.stdout.on('data', (chunk) => {
  if (chunk.toString('utf8').includes('ELECTRON_IPC_CALLED')) {
    ipcSawCall = true;
  }
});

try {
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Electron DevTools wsEndpoint')), 10000);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m && m[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Electron exited early (code=${code}, signal=${signal}): ${buf}`));
    });
  });

  const browser = await chromium.connectOverCDP(wsEndpoint);
  try {
    let page;
    for (let i = 0; i < 30; i += 1) {
      page = browser.contexts()[0]?.pages()[0];
      if (page && (await page.title()) === 'Electron Phase 0 Fixture') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!page) throw new Error('Electron renderer page not found');

    // Install Playwright route guard to prove renderer HTTP guard does NOT block Electron IPC
    const blockedHttp = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('data:')) {
        await route.continue();
        return;
      }
      blockedHttp.push(url);
      await route.abort();
    });

    await page.getByTestId('renderer-btn').click();
    const rendererOut = await page.locator('#out').textContent();

    await page.getByTestId('ipc-btn').click();
    await page.waitForTimeout(150);
    const ipcOut = await page.locator('#ipc-out').textContent();

    console.log(JSON.stringify({
      ok: true,
      wsEndpointProtocol: new URL(wsEndpoint).protocol,
      pageTitle: await page.title(),
      rendererOut,
      ipcOut,
      ipcBypassedPlaywrightRouteGuard: ipcSawCall && blockedHttp.length === 0,
      blockedHttpCount: blockedHttp.length,
    }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  child.kill('SIGTERM');
}
