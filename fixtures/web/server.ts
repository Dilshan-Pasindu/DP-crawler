import http from "node:http";

export interface WebFixtureServer {
  readonly baseUrl: string;
  readonly origin: string;
  readonly port: number;
  readonly recordedMutatingRequests: string[];
  readonly recordedWebSocketUpgrades: string[];
  close(): Promise<void>;
}

const ROUTES: Record<string, string> = {
  "/clean": `<!doctype html><html><body><main>
    <button data-testid="clean-btn" onclick="document.getElementById('out').textContent='clean-ok'">Inspect Info</button>
    <p id="out">idle</p>
  </main></body></html>`,

  "/js-exception": `<!doctype html><html><body><main>
    <button data-testid="boom-btn" onclick="throw new Error('Uncaught fixture boom')">Trigger JS Error</button>
  </main></body></html>`,

  "/console-error": `<!doctype html><html><body><main>
    <button data-testid="con-btn" onclick="console.error('Console failure observed'); document.getElementById('c').textContent='logged'">Log Console Error</button>
    <p id="c">idle</p>
  </main></body></html>`,

  "/nested-menu": `<!doctype html><html><body><nav>
    <button data-testid="menu-trigger" aria-expanded="false" onclick="
      const expanded = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', String(!expanded));
      document.getElementById('submenu').hidden = expanded;
    ">More Options</button>
    <div id="submenu" hidden>
      <button data-testid="submenu-item" onclick="document.getElementById('menu-out').textContent='sub-clicked'">View Audit Log</button>
    </div>
    <p id="menu-out">closed</p>
  </nav></body></html>`,

  "/hidden-disabled": `<!doctype html><html><body><main>
    <button data-testid="hidden-btn" style="display:none">Hidden Action</button>
    <button data-testid="disabled-btn" disabled>Disabled Action</button>
    <button data-testid="visible-btn" onclick="document.getElementById('hd-out').textContent='ok'">Visible Info</button>
    <p id="hd-out">idle</p>
  </main></body></html>`,

  "/destructive": `<!doctype html><html><body><main>
    <button data-testid="del-btn" onclick="fetch('/api/items/1', { method: 'DELETE' })">Delete Item</button>
    <button data-testid="camel-btn" onclick="fetch('/api/user/reset', { method: 'POST' })">resetUserAccount</button>
    <button data-testid="safe-btn" onclick="document.getElementById('d-out').textContent='safe'">View Summary</button>
    <p id="d-out">idle</p>
  </main></body></html>`,

  "/http-500": `<!doctype html><html><body><main>
    <button data-testid="err500-btn" onclick="fetch('/api/fail-500')">Fetch Report</button>
  </main></body></html>`,

  "/dead-button": `<!doctype html><html><body><main>
    <button data-testid="dead-btn" onclick="/* intentional no-op */">Broken Button</button>
  </main></body></html>`,

  "/obscured": `<!doctype html><html><body style="margin:0;height:1400px;">
    <header style="position:fixed;top:0;left:0;right:0;height:60px;background:#222;z-index:100;"></header>
    <div style="position:relative;margin-top:80px;">
      <button data-testid="blocked-btn" style="width:160px;height:40px;">Covered Control</button>
      <div id="overlay" style="position:absolute;top:0;left:0;width:200px;height:60px;background:rgba(0,0,0,0.4);z-index:10;">Overlay</div>
    </div>
    <button data-testid="scroll-recoverable-btn" style="margin-top:900px;" onclick="this.textContent='Recovered'">Scroll Target</button>
  </body></html>`,

  "/form-validation": `<!doctype html><html><body><main>
    <form id="f">
      <input id="email-input" data-testid="email-input" type="email" aria-label="Work Email" required />
      <button type="button" data-testid="validate-btn" onclick="
        const inp = document.getElementById('email-input');
        document.getElementById('val-msg').textContent = inp.checkValidity() ? 'valid' : 'Please enter valid email';
      ">Check Form</button>
      <p id="val-msg" role="status"></p>
    </form>
  </main></body></html>`,

  "/get-mutation": `<!doctype html><html><body><main>
    <button data-testid="get-mut-btn" onclick="fetch('/api/items/delete?id=42', { method: 'GET' })">Inspect Item 42</button>
  </main></body></html>`,

  "/blocked-mutation": `<!doctype html><html><body><main>
    <button data-testid="post-mut-btn" onclick="fetch('/api/orders/create', { method: 'POST', body: '{}' })">Create Preview</button>
  </main></body></html>`,

  "/websocket": `<!doctype html><html><body><main>
    <button data-testid="ws-btn" onclick="
      const ws = new WebSocket('ws://' + location.host + '/ws-live');
      ws.onerror = () => { document.getElementById('ws-out').textContent='ws-blocked'; };
    ">Connect Live Feed</button>
    <p id="ws-out">idle</p>
  </main></body></html>`,

  "/external-nav": `<!doctype html><html><body><main>
    <a data-testid="ext-link" href="https://example.org/outside">Partner Site</a>
    <button data-testid="redirect-btn" onclick="fetch('/api/redirect-external')">Check Redirect</button>
  </main></body></html>`,

  "/auth-protected": `<!doctype html><html><body><main>
    <div id="authed-badge">Signed in</div>
    <button data-testid="profile-btn" onclick="document.getElementById('p-out').textContent=sessionStorage.getItem('dp_tok')||'missing'">Read Session</button>
    <p id="p-out">idle</p>
  </main></body></html>`,

  "/login": `<!doctype html><html><body><main><h1>Login Required</h1></main></body></html>`,

  "/popup-error": `<!doctype html><html><body><main>
    <button data-testid="alert-btn" onclick="alert('Error: unable to process action')">Open Alert</button>
  </main></body></html>`,

  "/portal-toast": `<!doctype html><html><body>
    <main>
      <button data-testid="toast-btn" onclick="
        const portal = document.getElementById('toast-portal');
        const t = document.createElement('div');
        t.setAttribute('role', 'status');
        t.textContent = 'Preferences updated successfully';
        portal.appendChild(t);
      ">Apply View</button>
    </main>
    <div id="toast-portal"></div>
  </body></html>`,

  "/dynamic-dom": `<!doctype html><html><body><main id="dyn-root">
    <button data-testid="flaky-replace-btn" onclick="
      const b = document.getElementById('dyn-root');
      b.innerHTML = '<button data-testid=\\'replacement\\'>Different Button</button>';
    ">Refresh View</button>
  </main></body></html>`,

  "/duplicate-labels": `<!doctype html><html><body><main>
    <button onclick="document.getElementById('dup-out').textContent='one'">Inspect</button>
    <button onclick="document.getElementById('dup-out').textContent='two'">Inspect</button>
    <p id="dup-out">idle</p>
  </main></body></html>`,

  "/low-confidence": `<!doctype html><html><body><main>
    <button data-low-confidence="true" onclick="document.getElementById('lc').textContent='clicked'">Item 1</button>
    <p id="lc">idle</p>
  </main></body></html>`,

  "/infinite-scroll": `<!doctype html><body><main id="feed" style="min-height:1600px;">
    <button data-testid="feed-0" onclick="this.textContent='seen-0'">Feed Item 0</button>
  </main>
  <script>
    let idx = 1;
    window.addEventListener('scroll', () => {
      const feed = document.getElementById('feed');
      const btn = document.createElement('button');
      btn.setAttribute('data-testid', 'feed-' + idx);
      btn.textContent = 'Feed Item ' + idx;
      btn.style.marginTop = '450px';
      btn.style.display = 'block';
      feed.appendChild(btn);
      idx += 1;
    });
  </script></body></html>`,

  "/hostile-labels": `<!doctype html><html><body><main>
    <button data-testid="xss-btn">&lt;script&gt;alert('xss')&lt;/script&gt;</button>
  </main></body></html>`,

  "/redaction": `<!doctype html><html><body><main>
    <button data-testid="redact-btn" onclick="throw new Error('Failed for alice@example.com Bearer tok_secret_12345678 on https://localhost/api?token=abc')">Trigger Leak</button>
  </main></body></html>`,
};

/**
 * Starts a local 127.0.0.1 HTTP & WebSocket fixture server covering all 23 Phase 2 scenarios.
 */
export async function startWebFixtureServer(): Promise<WebFixtureServer> {
  const recordedMutatingRequests: string[] = [];
  const recordedWebSocketUpgrades: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/items/1" || url.pathname === "/api/user/reset" || url.pathname === "/api/items/delete" || url.pathname === "/api/orders/create") {
      recordedMutatingRequests.push(`${req.method} ${url.pathname}${url.search}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/fail-500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Simulated 500" }));
      return;
    }

    if (url.pathname === "/api/redirect-external") {
      res.writeHead(302, { Location: "https://example.org/redirected" });
      res.end();
      return;
    }

    if (url.pathname === "/auth-expired") {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }

    const html = ROUTES[url.pathname];
    if (html !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  server.on("upgrade", (req, socket) => {
    recordedWebSocketUpgrades.push(req.url ?? "/");
    socket.destroy();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  return {
    baseUrl: origin,
    origin,
    port,
    recordedMutatingRequests,
    recordedWebSocketUpgrades,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
