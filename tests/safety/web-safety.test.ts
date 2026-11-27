import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeSecretAuthFile } from "../../src/adapters/web/auth.js";
import { assertSafeApiRequest, PlaywrightWebAdapter } from "../../src/adapters/web/playwright.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { renderHtmlReport } from "../../src/brain/report/html.js";
import { renderJsonReport } from "../../src/brain/report/json.js";
import { renderMarkdownReport } from "../../src/brain/report/markdown.js";
import { startWebFixtureServer, type WebFixtureServer } from "../../fixtures/web/server.js";
import { makeDefaultTarget } from "../helpers/mock-adapter.js";

let server: WebFixtureServer;
const tempDirs: string[] = [];

beforeAll(async () => {
  server = await startWebFixtureServer();
});

afterEach(() => {
  server.recordedMutatingRequests.length = 0;
  server.recordedWebSocketUpgrades.length = 0;
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await server.close();
});

const DEFAULT_LIMITS = {
  maxDepth: 2,
  maxInteractions: 50,
  maxRunMinutes: 2,
  maxElementRetries: 1,
  maxRediscoveryPerState: 2,
};

describe("Phase 2 Web Safety Guarantees", () => {
  it("prevents destructive buttons, mutating GET requests, and POST mutations from reaching the fixture server", async () => {
    const adapter = new PlaywrightWebAdapter();
    for (const route of ["/destructive", "/get-mutation", "/blocked-mutation"]) {
      const report = await runCrawl({
        adapter,
        target: makeDefaultTarget({
          adapter: "playwright",
          entryPoint: `${server.baseUrl}${route}`,
          allowedOrigins: [server.origin],
        }),
        profile: "web-safety",
        configHash: "safe",
        limits: DEFAULT_LIMITS,
        confirmationMode: "off",
      });
      expect(report.completionStatus).toBe("COMPLETED");
      expect(server.recordedMutatingRequests).toHaveLength(0);
    }
  });

  it("blocks unapproved WebSocket connections before reaching the server", async () => {
    const adapter = new PlaywrightWebAdapter();
    const report = await runCrawl({
      adapter,
      target: makeDefaultTarget({
        adapter: "playwright",
        entryPoint: `${server.baseUrl}/websocket`,
        allowedOrigins: [server.origin],
      }),
      profile: "ws-safety",
      configHash: "ws",
      limits: DEFAULT_LIMITS,
      confirmationMode: "off",
    });

    expect(server.recordedWebSocketUpgrades).toHaveLength(0);
    expect(report.findings.some((f) => f.category === "application-error")).toBe(false);
  });

  it("blocks external redirects and standalone APIRequestContext mutations", async () => {
    const adapter = new PlaywrightWebAdapter();
    const report = await runCrawl({
      adapter,
      target: makeDefaultTarget({
        adapter: "playwright",
        entryPoint: `${server.baseUrl}/external-nav`,
        allowedOrigins: [server.origin],
      }),
      profile: "redirect-safety",
      configHash: "redir",
      limits: DEFAULT_LIMITS,
      confirmationMode: "off",
    });

    expect(report.elementOutcomes.some((o) => o.outcome === "BLOCKED")).toBe(true);
    expect(report.findings.some((f) => f.category === "application-error")).toBe(false);

    const target = makeDefaultTarget({
      adapter: "playwright",
      entryPoint: `${server.baseUrl}/clean`,
      allowedOrigins: [server.origin],
    });
    expect(() => assertSafeApiRequest(`${server.baseUrl}/api/orders/create`, "POST", target)).toThrow();
    expect(() => assertSafeApiRequest("https://evil.example/steal", "GET", target)).toThrow();
  });

  it("writes auth secrets with restrictive permissions and redacts PII/tokens from all report formats", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dpcrawl-auth-sec-"));
    tempDirs.push(tmp);
    const authFile = path.join(tmp, "auth", "user.session.json");
    writeSecretAuthFile(authFile, JSON.stringify({ origin: server.origin, entries: { token: "supersecret" } }));
    if (process.platform !== "win32") {
      expect(statSync(authFile).mode & 0o777).toBe(0o600);
    }

    const outDir = path.join(tmp, "reports");
    const adapter = new PlaywrightWebAdapter();
    const report = await runCrawl({
      adapter,
      target: makeDefaultTarget({
        adapter: "playwright",
        entryPoint: `${server.baseUrl}/redaction`,
        allowedOrigins: [server.origin],
        evidence: {
          outputDir: outDir,
          runId: "safety-redact",
          screenshots: true,
          screenshotMasks: [],
          trace: "off",
        },
      }),
      profile: "redact",
      configHash: "red",
      limits: DEFAULT_LIMITS,
      confirmationMode: "off",
    });

    const json = renderJsonReport(report);
    const html = renderHtmlReport(report);
    const md = renderMarkdownReport(report);
    for (const out of [json, html, md]) {
      expect(out).not.toContain("alice@example.com");
      expect(out).not.toContain("tok_secret_12345678");
      expect(out).not.toContain("token=abc");
    }
    expect(readFileSync(authFile, "utf8")).toContain("supersecret");
  });
});
