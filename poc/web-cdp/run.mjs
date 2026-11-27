import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

function resolveChromiumExecutable() {
  const defaultPath = chromium.executablePath();
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const candidates = [
    path.join(cacheDir, 'chromium_headless_shell-1255', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
    path.join(cacheDir, 'chromium-1255', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function startFixtureServer() {
  const mutatingCalls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
  <head><title>DP Crawler Phase 0 Fixture</title></head>
  <body>
    <main>
      <h1>Phase 0 Fixture</h1>
      <button data-testid="safe-btn" onclick="document.getElementById('status').textContent='clicked'; sessionStorage.setItem('poc_state','ok');">Safe Action</button>
      <button data-testid="delete-btn" onclick="fetch('/api/delete?id=1', { method: 'GET' })">Delete Item</button>
      <a href="https://example.com/" data-testid="ext-link">External Link</a>
      <p id="status">idle</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (url.pathname === '/api/delete') {
      mutatingCalls.push(`${req.method} ${url.pathname}${url.search}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === 'object' && addr ? addr.port : 0,
        mutatingCalls,
      });
    });
  });
}

async function runWebPoC(baseUrl, mutatingCalls, executablePath) {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const blockedRequests = [];
    // Install network guard BEFORE first navigation (Section 9.5)
    await page.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const allowedOrigin = new URL(baseUrl).origin;

      if (url.origin !== allowedOrigin) {
        blockedRequests.push(`EXT_ORIGIN ${req.method()} ${url.origin}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (req.method() !== 'GET' || url.pathname.includes('delete')) {
        blockedRequests.push(`MUTATION_GUARD ${req.method()} ${url.pathname}`);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const discovered = await page.locator('button, a').evaluateAll((els) =>
      els.map((el) => ({
        tag: el.tagName.toLowerCase(),
        testId: el.getAttribute('data-testid'),
        text: (el.textContent ?? '').trim(),
      })),
    );

    await page.getByTestId('safe-btn').click();
    const statusText = await page.locator('#status').textContent();
    const sessionSnap = await page.evaluate(() => JSON.stringify(sessionStorage));

    // Trigger blocked GET mutation via DOM click to prove server was never hit
    await page.getByTestId('delete-btn').click();
    await page.waitForTimeout(150);

    return {
      browserVersion: browser.version(),
      discoveredCount: discovered.length,
      discovered,
      statusText,
      sessionSnap,
      blockedRequests,
      serverMutatingCalls: mutatingCalls.length,
    };
  } finally {
    await browser.close();
  }
}

async function runCdpPoC(baseUrl, executablePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cdp-poc-'));
  const proc = spawn(
    executablePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  try {
    const wsEndpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for DevTools wsEndpoint')), 8000);
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match && match[1]) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };
      proc.stderr.on('data', onData);
      proc.stdout.on('data', onData);
      proc.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`CDP host exited early with code ${code}`));
      });
    });

    const browser = await chromium.connectOverCDP(wsEndpoint);
    try {
      const contexts = browser.contexts();
      const page = contexts[0]?.pages()[0] ?? (await contexts[0].newPage());
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      const title = await page.title();
      const cdpSession = await page.context().newCDPSession(page);
      const { targetInfo } = await cdpSession.send('Target.getTargetInfo');
      return {
        cdpAttached: true,
        wsEndpointProtocol: new URL(wsEndpoint).protocol,
        contextCount: contexts.length,
        pageTitle: title,
        targetType: targetInfo.type,
      };
    } finally {
      await browser.close();
    }
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

const { server, port, mutatingCalls } = await startFixtureServer();
const baseUrl = `http://127.0.0.1:${port}`;
const executablePath = resolveChromiumExecutable();

try {
  const webResult = await runWebPoC(baseUrl, mutatingCalls, executablePath);
  const cdpResult = await runCdpPoC(baseUrl, executablePath);
  console.log(JSON.stringify({ ok: true, executablePath, webResult, cdpResult }, null, 2));
} finally {
  server.close();
}
