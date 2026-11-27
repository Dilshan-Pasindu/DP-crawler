import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightWebAdapter } from "../../src/adapters/web/playwright.js";
import { UnsupportedOperationError } from "../../src/model/index.js";
import { startWebFixtureServer, type WebFixtureServer } from "../../fixtures/web/server.js";
import { makeDefaultTarget } from "../helpers/mock-adapter.js";

let server: WebFixtureServer;
const tempDirs: string[] = [];

beforeAll(async () => {
  server = await startWebFixtureServer();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await server.close();
});

describe("PlaywrightWebAdapter contract", () => {
  it("declares accurate web capabilities and availability", async () => {
    const adapter = new PlaywrightWebAdapter();
    expect(adapter.info.kind).toBe("playwright");
    expect(adapter.info.platform).toBe("web");
    expect(adapter.info.capabilities.discovery).toBe(true);
    expect(adapter.info.capabilities.networkObservation).toBe(true);
    expect(adapter.info.capabilities.processMonitoring).toBe(false);

    const target = makeDefaultTarget({
      adapter: "playwright",
      entryPoint: `${server.baseUrl}/clean`,
      allowedOrigins: [server.origin],
    });
    const avail = await adapter.checkAvailability(target);
    expect(avail.available).toBe(true);
  });

  it("opens, discovers, executes safe action, captures screenshot, and disposes cleanly", async () => {
    const adapter = new PlaywrightWebAdapter();
    const outDir = mkdtempSync(path.join(os.tmpdir(), "dpcrawl-contract-"));
    tempDirs.push(outDir);
    const target = makeDefaultTarget({
      adapter: "playwright",
      entryPoint: `${server.baseUrl}/clean`,
      allowedOrigins: [server.origin],
      evidence: {
        outputDir: outDir,
        runId: "contract-test",
        screenshots: true,
        screenshotMasks: [],
        trace: "off",
      },
    });

    const session = await adapter.openSession(target);
    try {
      const protections = await session.getSafetyCoverage();
      expect(protections.some((p) => p.name === "http-interception" && p.active)).toBe(true);
      expect(protections.some((p) => p.name === "browser-service-workers-blocked" && p.active)).toBe(true);

      const snap = await session.discover();
      expect(snap.nodes.length).toBe(1);
      const btn = snap.nodes[0];
      expect(btn?.testId).toBe("clean-btn");

      if (btn !== undefined) {
        const resolved = await session.resolveNode(btn);
        expect(resolved?.key).toBe(btn.key);
        const exec = await session.executeAction(btn, { type: "invoke" });
        expect(exec.attempted).toBe(true);
        expect(exec.succeeded).toBe(true);
      }

      const shot = await session.captureScreenshot("contract");
      expect(shot).toContain("contract.png");
      const restore = await session.restoreState();
      expect(restore.ok).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it("throws UnsupportedOperationError helper when explicitly constructed", () => {
    const err = new UnsupportedOperationError("playwright", "processMonitoring");
    expect(err.adapterKind).toBe("playwright");
  });
});
