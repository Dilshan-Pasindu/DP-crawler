import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WindowsUiaAdapter } from "../../src/adapters/windows/uia.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { makeDefaultTarget } from "../helpers/mock-adapter.js";

const isInteractiveWindows =
  process.platform === "win32" && process.env.DPCRAWL_RUN_WINDOWS_INTERACTIVE === "1";

describe("Windows Desktop Integration Suite", () => {
  if (!isInteractiveWindows) {
    it("explicitly reports non-Windows / non-interactive host as unavailable rather than claiming pass", async () => {
      const adapter = new WindowsUiaAdapter();
      const target = makeDefaultTarget({
        platform: "windows",
        adapter: "windows-uia",
        entryPoint: "fixtures/windows/WpfFixture/bin/Release/net8.0-windows/WpfFixture.exe",
      });
      const avail = await adapter.checkAvailability(target);
      expect(avail.available).toBe(false);
    });
    return;
  }

  const fixturePaths = [
    { name: "Win32", exe: "fixtures/windows/Win32Fixture/bin/Release/net8.0-windows/Win32Fixture.exe" },
    { name: "WinForms", exe: "fixtures/windows/WinFormsFixture/bin/Release/net8.0-windows/WinFormsFixture.exe" },
    { name: "WPF", exe: "fixtures/windows/WpfFixture/bin/Release/net8.0-windows/WpfFixture.exe" },
  ];

  for (const fx of fixturePaths) {
    it(`crawls ${fx.name} fixture safely in interactive Windows desktop session`, async () => {
      const absExe = path.resolve(process.cwd(), fx.exe);
      expect(existsSync(absExe)).toBe(true);

      const adapter = new WindowsUiaAdapter();
      const target = makeDefaultTarget({
        id: `win-${fx.name.toLowerCase()}`,
        platform: "windows",
        adapter: "windows-uia",
        entryPoint: absExe,
        processIdentity: path.basename(absExe),
      });

      const avail = await adapter.checkAvailability(target);
      expect(avail.available).toBe(true);

      const report = await runCrawl({
        adapter,
        target,
        profile: `win-${fx.name.toLowerCase()}`,
        configHash: `cfg-${fx.name}`,
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
      expect(report.coverage.discovered).toBeGreaterThan(0);
    });
  }
});
