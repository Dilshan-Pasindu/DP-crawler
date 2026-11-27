import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WindowsUiaAdapter } from "../../src/adapters/windows/uia.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { renderHtmlReport } from "../../src/brain/report/html.js";
import { renderMarkdownReport } from "../../src/brain/report/markdown.js";
import { makeDefaultTarget } from "../helpers/mock-adapter.js";

const tempDirs: string[] = [];

function createFakeWindowsHelper(): { scriptPath: string; outDir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dpcrawl-win-contract-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "fake-win-helper.mjs");
  const outDir = path.join(dir, "reports");

  const onePixelPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  writeFileSync(
    scriptPath,
    `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let status = 'idle';

rl.on('line', (line) => {
  const req = JSON.parse(line);
  switch (req.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: req.id, result: {
        protocolVersion: '1.0.0',
        helperName: 'fake-flaui',
        helperVersion: '0.1.0',
        capabilities: {
          discovery: true, invoke: true, setValue: true, toggle: true,
          select: true, expand: true, collapse: true, focus: true,
          screenshots: true, accessibilityEvents: true, stateRestore: false
        },
        environment: {
          osVersion: 'Windows 11 24H2', architecture: 'X64', interactiveDesktop: true,
          sessionStatus: 'OK', displaySummary: '1920x1080', dpi: 96,
          runtimeVersion: '.NET 8.0', backend: 'flaui-uia3'
        }
      }});
      break;
    case 'attachTarget':
      send({ jsonrpc: '2.0', id: req.id, result: {
        attached: true, processId: 4242,
        executablePath: 'C:\\\\Fixtures\\\\WpfFixture.exe',
        windowTitle: 'DP Crawler WPF Fixture'
      }});
      break;
    case 'discover':
      send({ jsonrpc: '2.0', id: req.id, result: {
        location: 'DP Crawler WPF Fixture',
        stateHash: 'wpf_hash_' + status,
        nodes: [
          {
            key: 'raw_hwnd_1001',
            role: 'Button',
            name: 'View Summary',
            context: 'DP Crawler WPF Fixture',
            automationId: 'wpf-safe-btn',
            visible: true, enabled: true, interactive: true,
            supportedActions: ['invoke', 'focus'],
            identityConfidence: 'HIGH',
            driverRef: 'uia_ref_1',
            children: []
          },
          {
            key: 'raw_hwnd_1002',
            role: 'Button',
            name: 'Delete All',
            context: 'DP Crawler WPF Fixture',
            automationId: 'wpf-delete-btn',
            visible: true, enabled: true, interactive: true,
            supportedActions: ['invoke', 'focus'],
            identityConfidence: 'HIGH',
            driverRef: 'uia_ref_2',
            children: []
          }
        ]
      }});
      break;
    case 'resolveNode':
      send({ jsonrpc: '2.0', id: req.id, result: {
        key: 'raw_hwnd_1001', role: 'Button', name: 'View Summary',
        context: 'DP Crawler WPF Fixture', automationId: 'wpf-safe-btn',
        visible: true, enabled: true, interactive: true,
        supportedActions: ['invoke', 'focus'], identityConfidence: 'HIGH',
        driverRef: 'uia_ref_1', children: []
      }});
      break;
    case 'executeAction':
      if (req.params.automationId === 'wpf-delete-btn') {
        throw new Error('BUG: Delete All should have been blocked by shared brain!');
      }
      status = 'clicked';
      send({ jsonrpc: '2.0', id: req.id, result: {
        attempted: true, succeeded: true, obscured: false, unstable: false,
        dispatchMayHaveHappened: true,
        signals: [{ kind: 'accessibility-event', detail: 'Invoked View Summary', inClickedSubtree: true }]
      }});
      break;
    case 'captureScreenshot':
      send({ jsonrpc: '2.0', id: req.id, result: { pngBase64: '${onePixelPngBase64}' } });
      break;
    case 'shutdown':
      send({ jsonrpc: '2.0', id: req.id, result: { ok: true } });
      process.exit(0);
  }
});`,
    "utf8",
  );

  return { scriptPath, outDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("WindowsUiaAdapter contract (fake stdio helper)", () => {
  it("runs full crawl through unchanged shared brain and renders shared reports", async () => {
    const { scriptPath, outDir } = createFakeWindowsHelper();
    const adapter = new WindowsUiaAdapter();

    const target = makeDefaultTarget({
      id: "wpf-fixture",
      platform: "windows",
      adapter: "windows-uia",
      entryPoint: "C:\\Fixtures\\WpfFixture.exe",
      processIdentity: "WpfFixture.exe",
      allowedOrigins: [],
      evidence: {
        outputDir: outDir,
        runId: "win-contract",
        screenshots: true,
        screenshotMasks: [],
        trace: "off",
      },
      windows: {
        uiaBackend: "uia3",
        helperCommand: process.execPath,
        helperArgs: [scriptPath],
      },
    });

    const avail = await adapter.checkAvailability(target);
    expect(avail.available).toBe(true);
    expect(avail.details.some((d) => d.includes("flaui-uia3"))).toBe(true);

    const report = await runCrawl({
      adapter,
      target,
      profile: "win-wpf",
      configHash: "winhash",
      limits: {
        maxDepth: 2,
        maxInteractions: 20,
        maxRunMinutes: 2,
        maxElementRetries: 1,
        maxRediscoveryPerState: 2,
      },
      confirmationMode: "off",
    });

    expect(report.completionStatus).toBe("COMPLETED");
    expect(report.platform).toBe("windows");
    expect(report.safetyCoverage.activeProtections).toContain("desktop-process-scoping");
    expect(report.safetyCoverage.unavailableProtections.some((u) => u.includes("http-interception"))).toBe(true);

    // Ensure raw HWND handle ('raw_hwnd_1001') was NOT used as permanent elementKey
    expect(report.elementOutcomes.every((o) => o.elementKey.startsWith("el_"))).toBe(true);
    expect(report.elementOutcomes.some((o) => o.name === "View Summary" && o.outcome === "PASS")).toBe(true);
    expect(report.elementOutcomes.some((o) => o.name === "Delete All" && o.outcome === "BLOCKED")).toBe(true);

    const html = renderHtmlReport(report);
    const md = renderMarkdownReport(report);
    expect(html).toContain("DP Crawler Diagnostic Report");
    expect(md).toContain("wpf\\-fixture");
  });
});
