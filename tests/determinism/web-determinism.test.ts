import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightWebAdapter } from "../../src/adapters/web/playwright.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { renderJsonReport } from "../../src/brain/report/json.js";
import { startWebFixtureServer, type WebFixtureServer } from "../../fixtures/web/server.js";
import { makeDefaultTarget } from "../helpers/mock-adapter.js";

let server: WebFixtureServer;

beforeAll(async () => {
  server = await startWebFixtureServer();
});

afterAll(async () => {
  await server.close();
});

describe("Phase 2 Web Determinism", () => {
  it("produces identical element keys, outcomes, finding IDs, and deterministic fields across 10 consecutive browser runs", async () => {
    const adapter = new PlaywrightWebAdapter();
    const snapshots: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      const report = await runCrawl({
        adapter,
        target: makeDefaultTarget({
          adapter: "playwright",
          entryPoint: `${server.baseUrl}/http-500`,
          allowedOrigins: [server.origin],
          evidence: {
            outputDir: "reports",
            runId: "det-fixed-run",
            screenshots: false,
            screenshotMasks: [],
            trace: "off",
          },
        }),
        profile: "web-det",
        configHash: "web_det_hash",
        limits: {
          maxDepth: 2,
          maxInteractions: 50,
          maxRunMinutes: 2,
          maxElementRetries: 1,
          maxRediscoveryPerState: 2,
        },
        confirmationMode: "off",
        clock: {
          nowMs: () => 1_700_000_000_000 + i * 500,
          isoNow: () => `2026-11-27T00:00:0${i}.000Z`,
          generateRunId: () => `run_${i}`,
        },
      });

      const { operational: _op, ...deterministic } = JSON.parse(renderJsonReport(report)) as Record<string, unknown>;
      snapshots.push(JSON.stringify(deterministic));
    }

    for (let i = 1; i < snapshots.length; i += 1) {
      expect(snapshots[i]).toBe(snapshots[0]);
    }
  }, 20_000);
});
