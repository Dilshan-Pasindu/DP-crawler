import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeSecretAuthFile } from "../../src/adapters/web/auth.js";
import { PlaywrightWebAdapter } from "../../src/adapters/web/playwright.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { renderHtmlReport } from "../../src/brain/report/html.js";
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

function createOutDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dpcrawl-web-int-"));
  tempDirs.push(dir);
  return dir;
}

async function crawlRoute(route: string, overrides?: Partial<ReturnType<typeof makeDefaultTarget>>) {
  const adapter = new PlaywrightWebAdapter();
  const outDir = createOutDir();
  return runCrawl({
    adapter,
    target: makeDefaultTarget({
      adapter: "playwright",
      entryPoint: `${server.baseUrl}${route}`,
      allowedOrigins: [server.origin],
      evidence: {
        outputDir: outDir,
        runId: "int-test",
        screenshots: true,
        screenshotMasks: [],
        trace: "off",
      },
      ...overrides,
    }),
    profile: "web-int",
    configHash: "int",
    limits: {
      maxDepth: 2,
      maxInteractions: 30,
      maxRunMinutes: 2,
      maxElementRetries: 1,
      maxRediscoveryPerState: 2,
    },
    confirmationMode: "off",
  });
}

describe("Phase 2 Web Integration — All 23 Fixtures (Section 17.3)", () => {
  it("1. Clean application passes with zero findings", async () => {
    const r = await crawlRoute("/clean");
    expect(r.completionStatus).toBe("COMPLETED");
    expect(r.findings).toHaveLength(0);
    expect(r.elementOutcomes[0]?.outcome).toBe("PASS");
  });

  it("2. JavaScript exception produces FAIL", async () => {
    const r = await crawlRoute("/js-exception");
    expect(r.elementOutcomes[0]?.outcome).toBe("FAIL");
    expect(r.findings[0]?.category).toBe("application-error");
  });

  it("3. Console error produces FAIL", async () => {
    const r = await crawlRoute("/console-error");
    expect(r.elementOutcomes[0]?.outcome).toBe("FAIL");
  });

  it("4. Nested menu rediscovers revealed submenu items", async () => {
    const r = await crawlRoute("/nested-menu");
    expect(r.coverage.discovered).toBeGreaterThanOrEqual(2);
    expect(r.elementOutcomes.some((o) => o.name === "View Audit Log" && o.outcome === "PASS")).toBe(true);
  });

  it("5. Hidden and disabled controls are blocked safely without clicking", async () => {
    const r = await crawlRoute("/hidden-disabled");
    expect(r.elementOutcomes.filter((o) => o.outcome === "BLOCKED").length).toBe(2);
    expect(r.elementOutcomes.some((o) => o.name === "Visible Info" && o.outcome === "PASS")).toBe(true);
  });

  it("6. Destructive actions are blocked and never reach server", async () => {
    const r = await crawlRoute("/destructive");
    expect(r.elementOutcomes.filter((o) => o.outcome === "BLOCKED").length).toBe(2);
    expect(server.recordedMutatingRequests).toHaveLength(0);
  });

  it("7. HTTP 500 produces FAIL with evidence screenshot", async () => {
    const r = await crawlRoute("/http-500");
    expect(r.elementOutcomes[0]?.outcome).toBe("FAIL");
    expect(r.evidenceReferences.length).toBe(1);
    if (r.evidenceReferences[0] !== undefined) {
      expect(existsSync(r.evidenceReferences[0])).toBe(true);
    }
  });

  it("8. Dead button produces DEAD", async () => {
    const r = await crawlRoute("/dead-button");
    expect(r.elementOutcomes[0]?.outcome).toBe("DEAD");
  });

  it("9. Obscured button detects OBSCURED while sticky-header target recovers via scroll", async () => {
    const r = await crawlRoute("/obscured");
    const blocked = r.elementOutcomes.find((o) => o.name === "Covered Control");
    const recovered = r.elementOutcomes.find((o) => o.name === "Scroll Target");
    expect(blocked?.outcome).toBe("OBSCURED");
    expect(recovered?.outcome).toBe("PASS");
  });

  it("10. Form validation reacts safely without forcing invalid submission", async () => {
    const r = await crawlRoute("/form-validation");
    const checkBtn = r.elementOutcomes.find((o) => o.name === "Check Form");
    expect(checkBtn?.outcome).toBe("PASS");
  });

  it("11. Mutating GET endpoint is blocked before hitting server", async () => {
    const r = await crawlRoute("/get-mutation");
    expect(r.elementOutcomes[0]?.outcome).not.toBe("FAIL");
    expect(server.recordedMutatingRequests).toHaveLength(0);
    expect(r.findings.filter((f) => f.category === "application-error")).toHaveLength(0);
  });

  it("12. Blocked HTTP POST mutation never hits server", async () => {
    const r = await crawlRoute("/blocked-mutation");
    expect(r.elementOutcomes[0]?.outcome).not.toBe("FAIL");
    expect(server.recordedMutatingRequests).toHaveLength(0);
    expect(r.findings.filter((f) => f.category === "application-error")).toHaveLength(0);
  });

  it("13. Unapproved WebSocket connection is blocked", async () => {
    const r = await crawlRoute("/websocket");
    expect(server.recordedWebSocketUpgrades).toHaveLength(0);
    expect(r.findings).toHaveLength(0);
  });

  it("14. External navigation link is blocked", async () => {
    const r = await crawlRoute("/external-nav");
    expect(r.elementOutcomes.some((o) => o.name === "Partner Site" && o.outcome === "BLOCKED")).toBe(true);
  });

  it("15. Expired authentication produces RUN_BLOCKED", async () => {
    const dir = createOutDir();
    const storagePath = path.join(dir, "storage.json");
    writeSecretAuthFile(storagePath, JSON.stringify({ cookies: [], origins: [] }));

    const r = await crawlRoute("/auth-expired", {
      auth: {
        mode: "replay",
        storageStatePath: storagePath,
        loginUrl: `${server.baseUrl}/login`,
      },
    });
    expect(r.completionStatus).toBe("RUN_BLOCKED");
    expect(r.completionReason).toContain("Authentication expired");
  });

  it("16. Pop-up alert error dialog produces FAIL", async () => {
    const r = await crawlRoute("/popup-error");
    expect(r.elementOutcomes[0]?.outcome).toBe("FAIL");
  });

  it("17. Out-of-subtree portal toast notification correlates as PASS", async () => {
    const r = await crawlRoute("/portal-toast");
    expect(r.elementOutcomes[0]?.outcome).toBe("PASS");
    expect(r.elementOutcomes[0]?.observation.changeCorrelated).toBe(true);
  });

  it("18. Dynamic DOM replacement avoids blind duplicate dispatch and reports cleanly", async () => {
    const r = await crawlRoute("/dynamic-dom");
    expect(r.completionStatus).toBe("COMPLETED");
    expect(r.elementOutcomes.length).toBeGreaterThanOrEqual(1);
  });

  it("19. Duplicate labels receive distinct element keys and both execute", async () => {
    const r = await crawlRoute("/duplicate-labels");
    const keys = r.elementOutcomes.map((o) => o.elementKey);
    expect(new Set(keys).size).toBe(2);
    expect(r.elementOutcomes.every((o) => o.outcome === "PASS")).toBe(true);
  });

  it("20. Low-confidence identity element is blocked by safety gate", async () => {
    const r = await crawlRoute("/low-confidence");
    expect(r.elementOutcomes[0]?.identityConfidence).toBe("LOW");
    expect(r.elementOutcomes[0]?.outcome).toBe("BLOCKED");
  });

  it("21. Infinite scrolling hits bounded scroll limit and marks incomplete exploration", async () => {
    const r = await crawlRoute("/infinite-scroll");
    expect(r.coverage.scrollLimitReached).toBe(true);
    expect(r.limitations.some((l) => l.includes("scroll limit reached"))).toBe(true);
  });

  it("22. Hostile HTML and Markdown labels are escaped in rendered reports", async () => {
    const r = await crawlRoute("/hostile-labels");
    const html = renderHtmlReport(r);
    const md = renderMarkdownReport(r);
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(md).not.toContain("<script>alert('xss')</script>");
  });

  it("23. Sensitive PII/tokens are redacted in findings and reports", async () => {
    const r = await crawlRoute("/redaction");
    expect(r.findings[0]?.errorSummary).not.toContain("alice@example.com");
    expect(r.findings[0]?.errorSummary).not.toContain("tok_secret_12345678");
    expect(r.findings[0]?.errorSummary).not.toContain("token=abc");
  });

  it("Replays saved sessionStorage cleanly when auth is valid", async () => {
    const dir = createOutDir();
    const storagePath = path.join(dir, "storage.json");
    const sessionPath = path.join(dir, "session.json");
    writeSecretAuthFile(storagePath, JSON.stringify({ cookies: [], origins: [] }));
    writeSecretAuthFile(sessionPath, JSON.stringify({ origin: server.origin, entries: { dp_tok: "ok_session" } }));

    const r = await crawlRoute("/auth-protected", {
      auth: {
        mode: "replay",
        storageStatePath: storagePath,
        sessionStoragePath: sessionPath,
        expectedAuthenticatedSelector: "#authed-badge",
      },
    });
    expect(r.completionStatus).toBe("COMPLETED");
    expect(r.elementOutcomes[0]?.outcome).toBe("PASS");
  });
});
