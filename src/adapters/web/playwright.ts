import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PNG } from "pngjs";
import {
  RunBlockedError,
  type AdapterInfo,
  type AdapterSession,
  type InteractionExecutionResult,
  type PlatformAdapter,
  type SafetyProtection,
  type StateSnapshot,
  type TargetDescriptor,
  type UIAction,
  type UniversalNode,
} from "../../model/index.js";
import {
  applySessionStorageReplay,
  assertSessionAuthenticated,
  buildContextOptions,
} from "./auth.js";
import { discoverWebSnapshot } from "./discovery.js";
import { executeWebAction, resolveAndVerifyWebNode } from "./interaction.js";
import { evaluateHttpRequestSafety, installNetworkGuard } from "./network-guard.js";
import { WebSignalCollector } from "./signals.js";

/**
 * Validates standalone APIRequestContext calls against target URL/method safety rules.
 */
export function assertSafeApiRequest(
  url: string,
  method: string,
  target: TargetDescriptor,
): void {
  const check = evaluateHttpRequestSafety(url, method, target);
  if (!check.allowed) {
    throw new RunBlockedError("API_REQUEST_BLOCKED", check.reason);
  }
}

/**
 * Playwright Chromium adapter implementing the shared PlatformAdapter contract.
 */
export class PlaywrightWebAdapter implements PlatformAdapter {
  readonly info: AdapterInfo = {
    kind: "playwright",
    platform: "web",
    version: "0.1.0",
    capabilities: {
      discovery: true,
      invoke: true,
      setValue: true,
      toggle: true,
      select: true,
      expand: true,
      collapse: true,
      focus: true,
      keyboard: true,
      pointer: true,
      scrolling: true,
      screenshots: true,
      accessibilityEvents: false,
      networkObservation: true,
      processMonitoring: false,
      stateRestore: true,
    },
  };

  async checkAvailability(target: TargetDescriptor): Promise<{
    readonly available: boolean;
    readonly details: readonly string[];
  }> {
    const exePath = target.executablePath ?? chromium.executablePath();
    if (!existsSync(exePath)) {
      return {
        available: false,
        details: [`Playwright Chromium executable not found at ${exePath}. Run playwright install chromium.`],
      };
    }
    return {
      available: true,
      details: [`Playwright Chromium available at ${exePath}`],
    };
  }

  async openSession(target: TargetDescriptor): Promise<AdapterSession> {
    const contextOptions = buildContextOptions(target);
    const launchOptions =
      target.executablePath !== undefined
        ? { headless: true, executablePath: target.executablePath }
        : { headless: true };

    const browser: Browser = await chromium.launch(launchOptions);
    let context: BrowserContext | null = null;

    try {
      context = await browser.newContext(contextOptions);
      await applySessionStorageReplay(context, target);

      const page: Page = await context.newPage();
      const signals = new WebSignalCollector(page, target);

      // Register network & WebSocket guards BEFORE first navigation
      await installNetworkGuard(context, target, (sig) => signals.pushSignal(sig));
      await signals.install();

      const response = await page.goto(target.entryPoint, { waitUntil: "domcontentloaded" });
      await assertSessionAuthenticated(page, target, response?.status() ?? null);

      const sessionId = `web_${Date.now().toString(36)}`;
      const adapterInfo: AdapterInfo = {
        ...this.info,
        runtimeVersion: `chromium-${browser.version()}`,
      };

      const evidenceRunDir = path.join(
        target.evidence?.outputDir ?? "reports",
        "evidence",
        target.evidence?.runId ?? sessionId,
      );
      const scrollLimitedLocations = new Set<string>();

      return {
        sessionId,
        adapterInfo,

        async getSafetyCoverage(): Promise<readonly SafetyProtection[]> {
          return [
            { name: "http-interception", active: true, required: true },
            { name: "websocket-connection-guard", active: true, required: true },
            { name: "browser-service-workers-blocked", active: true, required: true },
            {
              name: "redirect-hop-validation",
              active: true,
              required: false,
              reason: "Validated via response/frame listeners; OS-level egress firewall outside browser",
            },
            {
              name: "webrtc-webtransport-egress-guard",
              active: false,
              required: false,
              reason: "Playwright routing does not intercept WebRTC, WebTransport, or native OS sockets",
            },
          ];
        },

        async discover(): Promise<StateSnapshot> {
          const currentUrl = page.url();
          const alreadyLimited = scrollLimitedLocations.has(currentUrl);
          const snap = await discoverWebSnapshot(
            page,
            alreadyLimited ? { maxScrollAttempts: 0 } : undefined,
          );
          if (snap.scrollLimitReached === true) {
            scrollLimitedLocations.add(currentUrl);
          }
          return snap;
        },

        async resolveNode(node: UniversalNode): Promise<UniversalNode | null> {
          return resolveAndVerifyWebNode(page, node);
        },

        async executeAction(node: UniversalNode, action: UIAction): Promise<InteractionExecutionResult> {
          return executeWebAction({ page, node, action, signals });
        },

        async captureScreenshot(label: string): Promise<string | null> {
          if (target.evidence?.screenshots === false) {
            return null;
          }
          mkdirSync(evidenceRunDir, { recursive: true });
          const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
          const outPath = path.join(evidenceRunDir, `${safeLabel}.png`);
          const maskLocators = (target.evidence?.screenshotMasks ?? []).map((sel) => page.locator(sel));
          const pngBuffer = await page.screenshot({
            mask: maskLocators,
            fullPage: false,
          });
          // Verify valid PNG structure via pngjs before writing
          PNG.sync.read(pngBuffer);
          writeFileSync(outPath, pngBuffer);
          return outPath;
        },

        async restoreState(): Promise<{ readonly ok: boolean; readonly reason?: string }> {
          try {
            const res = await page.goto(target.entryPoint, { waitUntil: "domcontentloaded" });
            await assertSessionAuthenticated(page, target, res?.status() ?? null);
            return { ok: true };
          } catch (err) {
            return {
              ok: false,
              reason: err instanceof Error ? err.message : String(err),
            };
          }
        },

        async dispose(): Promise<void> {
          await context?.close().catch(() => {});
          await browser.close().catch(() => {});
        },
      };
    } catch (err) {
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
      throw err;
    }
  }
}
