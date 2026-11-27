import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWindowsHelperLaunch, verifyWindowsProcessBoundary } from "../../src/adapters/windows/process.js";
import { WindowsUiaAdapter } from "../../src/adapters/windows/uia.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { makeDefaultTarget } from "../helpers/mock-adapter.js";

const tempDirs: string[] = [];

function writeFakeHelper(body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dpcrawl-win-safety-"));
  tempDirs.push(dir);
  const file = path.join(dir, "helper.mjs");
  writeFileSync(file, body, "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Windows adapter safety & scoping", () => {
  it("defaults strictly to UIA3 and uses UIA2 only when explicitly configured", () => {
    const defaultTarget = makeDefaultTarget({ platform: "windows", adapter: "windows-uia" });
    expect(resolveWindowsHelperLaunch(defaultTarget).backend).toBe("uia3");

    const uia2Target = makeDefaultTarget({
      platform: "windows",
      adapter: "windows-uia",
      windows: { uiaBackend: "uia2" },
    });
    expect(resolveWindowsHelperLaunch(uia2Target).backend).toBe("uia2");
  });

  it("enforces process executable identity boundary", () => {
    expect(verifyWindowsProcessBoundary("WpfFixture.exe", "C:\\Apps\\WpfFixture.exe").valid).toBe(true);
    expect(verifyWindowsProcessBoundary("WpfFixture.exe", "C:\\Windows\\notepad.exe").valid).toBe(false);
  });

  it("reports BLOCKED_ENVIRONMENT cleanly as RUN_BLOCKED when interactive desktop is unavailable", async () => {
    const script = writeFakeHelper(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
            protocolVersion: '1.0.0', helperName: 'win', helperVersion: '0.1',
            capabilities: { discovery: true, invoke: true, setValue: true, toggle: true, select: true, expand: true, collapse: true, focus: true, screenshots: false },
            environment: {
              osVersion: 'Windows Server 2022', architecture: 'X64', interactiveDesktop: false,
              sessionStatus: 'BLOCKED_ENVIRONMENT',
              sessionReason: 'Interactive desktop unavailable on headless runner',
              runtimeVersion: '.NET 8.0', backend: 'flaui-uia3'
            }
          }}) + '\\n');
          return;
        }
        if (req.method === 'shutdown') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n'); process.exit(0); }
      });
    `);

    const adapter = new WindowsUiaAdapter();
    const target = makeDefaultTarget({
      platform: "windows",
      adapter: "windows-uia",
      entryPoint: "WpfFixture.exe",
      windows: { uiaBackend: "uia3", helperCommand: process.execPath, helperArgs: [script] },
    });

    const report = await runCrawl({
      adapter,
      target,
      profile: "headless-win",
      configHash: "hw",
      limits: { maxDepth: 2, maxInteractions: 10, maxRunMinutes: 1, maxElementRetries: 1, maxRediscoveryPerState: 2 },
      confirmationMode: "off",
    });

    expect(report.completionStatus).toBe("RUN_BLOCKED");
    expect(report.completionReason).toContain("Interactive desktop unavailable");
  });

  it("refuses interaction when foreground window belongs to an unrelated or UAC process, and reports helper crashes", async () => {
    const script = writeFakeHelper(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          send({ jsonrpc: '2.0', id: req.id, result: {
            protocolVersion: '1.0.0', helperName: 'win', helperVersion: '0.1',
            capabilities: { discovery: true, invoke: true, setValue: true, toggle: true, select: true, expand: true, collapse: true, focus: true, screenshots: false },
            environment: { osVersion: 'Windows 11', architecture: 'X64', interactiveDesktop: true, sessionStatus: 'OK', runtimeVersion: '.NET 8', backend: 'flaui-uia3' }
          }});
          return;
        }
        if (req.method === 'attachTarget') {
          send({ jsonrpc: '2.0', id: req.id, result: { attached: true, processId: 99, executablePath: 'C:\\\\App\\\\Target.exe', windowTitle: 'Target' }});
          return;
        }
        if (req.method === 'discover') {
          send({ jsonrpc: '2.0', id: req.id, result: {
            location: 'Target', stateHash: 'h1',
            nodes: [
              { key: '1', role: 'Button', name: 'Btn1', context: 'Target', automationId: 'btn1', visible: true, enabled: true, interactive: true, supportedActions: ['invoke'], identityConfidence: 'HIGH', driverRef: 'r1', children: [] },
              { key: '2', role: 'Button', name: 'Btn2', context: 'Target', automationId: 'btn2', visible: true, enabled: true, interactive: true, supportedActions: ['invoke'], identityConfidence: 'HIGH', driverRef: 'r2', children: [] }
            ]
          }});
          return;
        }
        if (req.method === 'executeAction') {
          if (req.params.automationId === 'btn1') {
            send({ jsonrpc: '2.0', id: req.id, result: { attempted: false, succeeded: false, obscured: true, unstable: false, foregroundProcessMismatch: true, signals: [] }});
          } else {
            process.exit(99);
          }
          return;
        }
        if (req.method === 'shutdown') { send({ jsonrpc: '2.0', id: req.id, result: {} }); process.exit(0); }
      });
    `);

    const adapter = new WindowsUiaAdapter();
    const report = await runCrawl({
      adapter,
      target: makeDefaultTarget({
        platform: "windows",
        adapter: "windows-uia",
        entryPoint: "Target.exe",
        processIdentity: "Target.exe",
        windows: { uiaBackend: "uia3", helperCommand: process.execPath, helperArgs: [script] },
      }),
      profile: "fg-guard",
      configHash: "fg",
      limits: { maxDepth: 1, maxInteractions: 10, maxRunMinutes: 1, maxElementRetries: 0, maxRediscoveryPerState: 1 },
      confirmationMode: "off",
    });

    expect(report.elementOutcomes.find((o) => o.name === "Btn1")?.outcome).toBe("OBSCURED");
    expect(report.elementOutcomes.find((o) => o.name === "Btn2")?.outcome).toBe("FAIL");
    expect(report.findings.some((f) => f.category === "process-crash")).toBe(true);
  });
});
