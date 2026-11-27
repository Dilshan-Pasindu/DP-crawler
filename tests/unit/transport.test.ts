import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperProcessManager } from "../../src/transports/process-manager.js";

const tempDirs: string[] = [];

function createMockHelperScript(source: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dpcrawl-rpc-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "helper.mjs");
  writeFileSync(file, source, "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("JSON-RPC stdio transport & HelperProcessManager", () => {
  it("handles initialize handshake, ping, timeout cancellation, and graceful shutdown", async () => {
    const script = createMockHelperScript(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const timers = new Map();
      const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          send({ jsonrpc: '2.0', id: req.id, result: {
            protocolVersion: '1.0.0',
            helperName: 'test-helper',
            helperVersion: '0.1.0',
            capabilities: {
              discovery: true, invoke: true, setValue: true, toggle: true,
              select: false, expand: false, collapse: false, focus: true,
              screenshots: false
            },
            environment: {
              osVersion: 'TestOS', architecture: 'X64', interactiveDesktop: true,
              sessionStatus: 'OK', runtimeVersion: 'mock', backend: 'flaui-uia3'
            }
          }});
          return;
        }
        if (req.method === 'ping') { send({ jsonrpc: '2.0', id: req.id, result: { ok: true } }); return; }
        if (req.method === 'slow') {
          const t = setTimeout(() => send({ jsonrpc: '2.0', id: req.id, result: { done: true } }), 500);
          timers.set(req.id, t);
          return;
        }
        if (req.method === '$/cancelRequest') {
          const t = timers.get(req.params?.id);
          if (t) { clearTimeout(t); timers.delete(req.params.id); }
          return;
        }
        if (req.method === 'shutdown') { send({ jsonrpc: '2.0', id: req.id, result: { ok: true } }); process.exit(0); }
      });
    `);

    const mgr = await HelperProcessManager.spawn({ command: process.execPath, args: [script] });
    expect(mgr.initializeResult.protocolVersion).toBe("1.0.0");
    expect(await mgr.healthCheck()).toBe(true);

    await expect(mgr.client.request("slow", {}, 80)).rejects.toThrow(/timed out/);
    await mgr.shutdown();
    expect(mgr.isAlive()).toBe(false);
  });

  it("rejects incompatible protocol major versions", async () => {
    const script = createMockHelperScript(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
            protocolVersion: '2.0.0',
            helperName: 'bad', helperVersion: '2.0',
            capabilities: { discovery: true, invoke: true, setValue: false, toggle: false, select: false, expand: false, collapse: false, focus: false, screenshots: false },
            environment: { osVersion: 'Test', architecture: 'X64', interactiveDesktop: true, sessionStatus: 'OK', runtimeVersion: 'mock', backend: 'uia3' }
          }}) + '\\n');
        }
      });
    `);

    await expect(HelperProcessManager.spawn({ command: process.execPath, args: [script] })).rejects.toThrow(
      /Incompatible helper protocol version/,
    );
  });

  it("detects helper crashes and redacts secrets from stderr tail", async () => {
    const script = createMockHelperScript(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
            protocolVersion: '1.0.0',
            helperName: 'crasher', helperVersion: '0.1',
            capabilities: { discovery: true, invoke: true, setValue: false, toggle: false, select: false, expand: false, collapse: false, focus: false, screenshots: false },
            environment: { osVersion: 'Test', architecture: 'X64', interactiveDesktop: true, sessionStatus: 'OK', runtimeVersion: 'mock', backend: 'uia3' }
          }}) + '\\n');
          return;
        }
        if (req.method === 'boom') {
          process.stderr.write('Crash with Bearer secret_token_12345 for alice@example.com\\n');
          process.exit(17);
        }
      });
    `);

    const mgr = await HelperProcessManager.spawn({ command: process.execPath, args: [script] });
    await expect(mgr.client.request("boom", {}, 2000)).rejects.toThrow(/Helper process exited/);
    expect(mgr.isAlive()).toBe(false);
    expect(mgr.getStderrSummary()).not.toContain("secret_token_12345");
    expect(mgr.getStderrSummary()).not.toContain("alice@example.com");
  });
});
