/// <reference lib="dom" />
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { RunBlockedError, type TargetDescriptor } from "../../model/index.js";
import { evaluateHttpRequestSafety } from "./network-guard.js";

export interface SessionStoragePayload {
  readonly origin: string;
  readonly entries: Record<string, string>;
}

/**
 * Ensures restrictive directory/file permissions on Unix-like systems
 * (Windows requires equivalent filesystem ACLs).
 */
export function writeSecretAuthFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
  }
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o600);
    const mode = statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`Auth state file ${filePath} has overly permissive mode ${mode.toString(8)}`);
    }
  }
}

/**
 * Validates and loads persisted sessionStorage entries for replay.
 */
export function loadSessionStorageFile(filePath: string): SessionStoragePayload {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<SessionStoragePayload>;
  if (
    typeof parsed.origin !== "string" ||
    parsed.origin.length === 0 ||
    typeof parsed.entries !== "object" ||
    parsed.entries === null
  ) {
    throw new RunBlockedError("AUTH_INVALID_STATE", "Invalid sessionStorage state format.");
  }
  return {
    origin: parsed.origin,
    entries: parsed.entries as Record<string, string>,
  };
}

/**
 * Builds Playwright BrowserContextOptions for the target's authentication mode
 * while blocking service workers for strict network guard enforcement.
 */
export function buildContextOptions(target: TargetDescriptor): BrowserContextOptions {
  const options: BrowserContextOptions = {
    serviceWorkers: "block",
  };

  if (target.auth?.mode === "replay") {
    if (target.auth.storageStatePath === undefined || !existsSync(target.auth.storageStatePath)) {
      throw new RunBlockedError("AUTH_MISSING", "Saved authentication storageState file not found.");
    }
    options.storageState = target.auth.storageStatePath;
  }

  if (target.auth?.mode === "api-token") {
    const envVar = target.auth.tokenEnvVar;
    if (envVar === undefined) {
      throw new RunBlockedError("AUTH_CONFIG_ERROR", "tokenEnvVar must be set for api-token auth mode.");
    }
    const token = process.env[envVar];
    if (token === undefined || token.trim().length === 0) {
      throw new RunBlockedError("AUTH_MISSING_TOKEN", `Environment variable "${envVar}" is not set.`);
    }
    const entryCheck = evaluateHttpRequestSafety(target.entryPoint, "GET", target);
    if (!entryCheck.allowed) {
      throw new RunBlockedError("AUTH_UNSAFE_ORIGIN", entryCheck.reason);
    }
    options.extraHTTPHeaders = {
      Authorization: `Bearer ${token}`,
    };
  }

  return options;
}

/**
 * Restores separate sessionStorage into a BrowserContext before page scripts run.
 */
export async function applySessionStorageReplay(
  context: BrowserContext,
  target: TargetDescriptor,
): Promise<void> {
  if (target.auth?.mode !== "replay" || target.auth.sessionStoragePath === undefined) {
    return;
  }
  if (!existsSync(target.auth.sessionStoragePath)) {
    throw new RunBlockedError("AUTH_MISSING", "Saved sessionStorage state file not found.");
  }
  const payload = loadSessionStorageFile(target.auth.sessionStoragePath);
  await context.addInitScript(
    ({ origin, entries }) => {
      if (window.location.origin === origin) {
        for (const [k, v] of Object.entries(entries)) {
          window.sessionStorage.setItem(k, v);
        }
      }
    },
    payload,
  );
}

/**
 * Checks whether the active session appears expired (redirected to login or HTTP 401).
 */
export async function assertSessionAuthenticated(
  page: Page,
  target: TargetDescriptor,
  initialStatus: number | null,
): Promise<void> {
  if (target.auth === undefined || target.auth.mode === "none") {
    return;
  }

  if (initialStatus === 401) {
    throw new RunBlockedError("AUTH_EXPIRED", "Authentication expired: server returned HTTP 401.");
  }

  const currentUrl = page.url();
  if (target.auth.loginUrl !== undefined && currentUrl.startsWith(target.auth.loginUrl)) {
    throw new RunBlockedError("AUTH_EXPIRED", `Authentication expired: redirected to ${currentUrl}`);
  }

  if (currentUrl.toLowerCase().includes("/login") && !target.entryPoint.toLowerCase().includes("/login")) {
    throw new RunBlockedError("AUTH_EXPIRED", `Authentication expired: redirected to login route ${currentUrl}`);
  }

  if (target.auth.expectedAuthenticatedSelector !== undefined) {
    const count = await page.locator(target.auth.expectedAuthenticatedSelector).count();
    if (count === 0) {
      throw new RunBlockedError(
        "AUTH_EXPIRED",
        "Authentication expired: expected authenticated UI selector is missing.",
      );
    }
  }
}

/**
 * Captures human-entered interactive authentication state without taking screenshots,
 * traces, or logging request/response bodies.
 */
export async function captureInteractiveWebAuth(params: {
  readonly browser: Browser;
  readonly target: TargetDescriptor;
  readonly storageStateOut: string;
  readonly sessionStorageOut: string;
  readonly waitForReady: (page: Page) => Promise<void>;
}): Promise<void> {
  // Never enable tracing or screenshots during interactive authentication
  const context = await params.browser.newContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.goto(params.target.entryPoint, { waitUntil: "domcontentloaded" });
    await params.waitForReady(page);

    const storageState = await context.storageState({ indexedDB: true });
    writeSecretAuthFile(params.storageStateOut, `${JSON.stringify(storageState, null, 2)}\n`);

    const sessionEntries = await page.evaluate(() => {
      const result: Record<string, string> = {};
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const key = window.sessionStorage.key(i);
        if (key !== null) {
          const val = window.sessionStorage.getItem(key);
          if (val !== null) result[key] = val;
        }
      }
      return result;
    });

    const origin = new URL(page.url()).origin;
    writeSecretAuthFile(
      params.sessionStorageOut,
      `${JSON.stringify({ origin, entries: sessionEntries }, null, 2)}\n`,
    );
  } finally {
    await context.close();
  }
}
