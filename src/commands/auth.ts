import path from "node:path";
import { chromium } from "playwright";
import { captureInteractiveWebAuth } from "../adapters/web/auth.js";
import { getProfile, loadConfigFile, profileToTargetDescriptor } from "../config.js";

/**
 * Manages authentication workflows (`dpcrawl auth`).
 * Interactive capture never records screenshots, traces, or request/response bodies.
 */
export async function runAuthCommand(params: {
  readonly configPath: string;
  readonly profileName: string;
  readonly interactiveWaitMs?: number;
}): Promise<{ readonly mode: string; readonly message: string }> {
  const config = await loadConfigFile(params.configPath);
  const profile = getProfile(config, params.profileName);
  const target = profileToTargetDescriptor(params.profileName, profile);

  if (profile.auth.mode === "interactive" && target.platform === "web") {
    const storageStateOut =
      profile.auth.storageStatePath ?? path.join("auth", `${params.profileName}.storage.json`);
    const sessionStorageOut =
      profile.auth.sessionStoragePath ?? path.join("auth", `${params.profileName}.session.json`);

    const browser = await chromium.launch({ headless: false });
    try {
      await captureInteractiveWebAuth({
        browser,
        target,
        storageStateOut,
        sessionStorageOut,
        waitForReady: async (page) => {
          if (params.interactiveWaitMs !== undefined) {
            await page.waitForTimeout(params.interactiveWaitMs);
            return;
          }
          await page.waitForEvent("close", { timeout: 300_000 }).catch(() => {});
        },
      });
    } finally {
      await browser.close().catch(() => {});
    }

    return {
      mode: "interactive",
      message: `Saved sensitive auth state with restrictive permissions to ${storageStateOut} and ${sessionStorageOut}. Never commit auth/ files.`,
    };
  }

  return {
    mode: profile.auth.mode,
    message: `Authentication mode "${profile.auth.mode}" configured for profile "${params.profileName}". Never store raw credentials in config or reports.`,
  };
}
