import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(__dirname, 'helper.mjs');

class RpcClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

    this.rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== null && msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        } else {
          entry.resolve(msg.result);
        }
      }
    });

    proc.on('exit', (code, signal) => {
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error(`Helper exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });
  }

  request(method, params = {}, timeoutMs = 1000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

async function main() {
  // 1. Handshake, cancellation, timeout, graceful shutdown
  const child1 = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc1 = new RpcClient(child1);

  const initRes = await rpc1.request('initialize', { clientVersion: '0.0.0' });
  assert.equal(initRes.protocolVersion, '1.0.0');
  assert.equal(initRes.capabilities.discovery, true);

  // Timeout check
  await assert.rejects(() => rpc1.request('slowOp', { delayMs: 400 }, 80), /Timeout after 80ms/);

  // Cancellation check
  const cancelPromise = rpc1.request('slowOp', { delayMs: 500 }, 2000);
  const cancelTargetId = rpc1.nextId - 1;
  rpc1.notify('$/cancelRequest', { id: cancelTargetId });
  await assert.rejects(() => cancelPromise, /Request cancelled/);

  // Graceful shutdown
  const shutRes = await rpc1.request('shutdown');
  assert.equal(shutRes.shuttingDown, true);

  // 2. Crash detection check
  const child2 = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc2 = new RpcClient(child2);
  await rpc2.request('initialize');
  await assert.rejects(() => rpc2.request('crashNow'), /Helper exited unexpectedly \(code=42/);

  console.log(JSON.stringify({
    ok: true,
    checks: ['handshake', 'timeout', 'cancellation', 'graceful_shutdown', 'crash_detection'],
    capabilities: initRes.capabilities,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
