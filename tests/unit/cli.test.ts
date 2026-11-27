import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { createCli } from "../../src/cli.js";
import { runAcceptCommand } from "../../src/commands/accept.js";
import { runDoctorCommand } from "../../src/commands/doctor.js";
import { runInspectCommand } from "../../src/commands/inspect.js";
import { runCrawlCommand } from "../../src/commands/run.js";
import { makeMockNode, MockAdapter } from "../helpers/mock-adapter.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dpcrawl-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("CLI and commands", () => {
  it("exposes expected CLI commands in help output", () => {
    const help = createCli().helpInformation();
    expect(help).toContain("doctor");
    expect(help).toContain("inspect");
    expect(help).toContain("run");
    expect(help).toContain("auth");
    expect(help).toContain("accept");
  });

  it("runs doctor, inspect (without clicking), run (writing reports), and accept", async () => {
    const dir = makeTempDir();
    const outDir = path.join(dir, "reports");
    const cfgPath = path.join(dir, "dpcrawl.json");

    writeFileSync(
      cfgPath,
      JSON.stringify({
        profiles: {
          "mock-local": {
            target: {
              id: "sample-app",
              platform: "web",
              adapter: "mock",
              startUrl: "http://localhost:5173/",
              allowedOrigins: ["http://localhost:5173"],
            },
            evidence: { outputDir: outDir },
            confirmation: "off",
          },
        },
      }),
      "utf8",
    );

    const safeBtn = makeMockNode({ role: "button", name: "Details", context: "/", testId: "details" });
    const deadBtn = makeMockNode({ role: "button", name: "Broken", context: "/", testId: "broken" });
    let executeCalls = 0;

    const adapter = new MockAdapter({
      scenario: {
        initialLocation: "/",
        nodesByLocation: { "/": [safeBtn, deadBtn] },
        actionHandlers: {
          [safeBtn.key]: () => {
            executeCalls += 1;
            return {
              attempted: true,
              succeeded: true,
              obscured: false,
              unstable: false,
              signals: [{ kind: "dom-mutation", targetKey: safeBtn.key, detail: "ok", inClickedSubtree: true }],
            };
          },
          [deadBtn.key]: () => {
            executeCalls += 1;
            return {
              attempted: true,
              succeeded: true,
              obscured: false,
              unstable: false,
              signals: [],
            };
          },
        },
      },
    });

    const registry = new AdapterRegistry();
    registry.register(adapter);

    const doc = await runDoctorCommand({ configPath: cfgPath, profileName: "mock-local", registry });
    expect(doc.ok).toBe(true);

    const discoveryPath = path.join(outDir, "discovery.json");
    const inspectRes = await runInspectCommand({
      configPath: cfgPath,
      profileName: "mock-local",
      registry,
      outputFile: discoveryPath,
    });
    expect(inspectRes.snapshot.nodes).toHaveLength(2);
    expect(executeCalls).toBe(0);
    expect(existsSync(discoveryPath)).toBe(true);

    const crawlRes = await runCrawlCommand({
      configPath: cfgPath,
      profileName: "mock-local",
      registry,
    });
    expect(crawlRes.report.completionStatus).toBe("COMPLETED");
    expect(executeCalls).toBe(2);

    const jsonPath = path.join(outDir, "report.json");
    const htmlPath = path.join(outDir, "report.html");
    const mdPath = path.join(outDir, "bugs.md");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    expect(readFileSync(htmlPath, "utf8")).toContain("Content-Security-Policy");

    const suggestion = await runAcceptCommand(jsonPath, "2026-11-27T00:00:00.000Z");
    expect(suggestion.baselineEntries.length).toBeGreaterThanOrEqual(1);
  });
});
