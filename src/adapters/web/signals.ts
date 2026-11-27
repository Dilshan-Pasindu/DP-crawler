/// <reference lib="dom" />
import type { ConsoleMessage, Dialog, Page, Response } from "playwright";
import type { SignalEvent, TargetDescriptor } from "../../model/index.js";
import { evaluateHttpRequestSafety, validateRedirectChain } from "./network-guard.js";

interface PortalMutationRecord {
  readonly text: string;
  readonly timestamp: number;
  readonly role: string;
}

const PORTAL_OBSERVER_INIT_SCRIPT = `(() => {
  if (window.__dpPortalInstalled) return;
  window.__dpPortalInstalled = true;
  window.__dpPortalEvents = [];
  const seenPreExisting = new Set();

  const snapshotExisting = () => {
    const nodes = document.querySelectorAll('[role="status"], [role="alert"], [aria-live], [data-toast], .toast');
    for (const el of nodes) {
      const txt = (el.textContent || '').trim();
      if (txt) seenPreExisting.add(txt);
    }
  };

  const attachObserver = () => {
    if (!document.body) return false;
    snapshotExisting();
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (!(added instanceof Element)) continue;
          const role = added.getAttribute('role') || (added.matches('[aria-live], [data-toast], .toast') ? 'toast' : '');
          const live = added.querySelector?.('[role="status"], [role="alert"], [aria-live], [data-toast], .toast');
          const targetEl = role ? added : live;
          if (!targetEl) continue;
          const text = (targetEl.textContent || '').trim();
          if (!text || seenPreExisting.has(text)) continue;
          window.__dpPortalEvents.push({
            text: text.slice(0, 300),
            timestamp: Date.now(),
            role: targetEl.getAttribute('role') || 'toast'
          });
        }
        if (m.type === 'characterData' || m.type === 'childList') {
          const el = m.target instanceof Element ? m.target : m.target.parentElement;
          if (el && el.matches?.('[role="status"], [role="alert"], [aria-live]')) {
            const text = (el.textContent || '').trim();
            if (text && !seenPreExisting.has(text)) {
              window.__dpPortalEvents.push({
                text: text.slice(0, 300),
                timestamp: Date.now(),
                role: el.getAttribute('role') || 'live'
              });
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  };

  if (!attachObserver()) {
    document.addEventListener('DOMContentLoaded', () => { attachObserver(); }, { once: true });
  }
})();`;

const ERROR_TOAST_HINTS = ["something went wrong", "error", "failed", "exception", "unable to"];

/**
 * Collects Playwright runtime events, HTTP response failures, redirect checks,
 * pop-ups, dialogs, and out-of-subtree portal notifications within an interaction window.
 */
export class WebSignalCollector {
  private readonly page: Page;
  private readonly target: TargetDescriptor;
  private windowSignals: SignalEvent[] = [];
  private preClickNotificationTexts = new Set<string>();
  private lastNavigatedUrl: string;

  constructor(page: Page, target: TargetDescriptor) {
    this.page = page;
    this.target = target;
    this.lastNavigatedUrl = page.url();
  }

  async install(): Promise<void> {
    await this.page.addInitScript(PORTAL_OBSERVER_INIT_SCRIPT);

    this.page.on("pageerror", (err: Error) => {
      this.windowSignals.push({
        kind: "notification",
        detail: `Uncaught pageerror: ${err.message}`,
        inClickedSubtree: false,
        error: {
          code: "JS_EXCEPTION",
          category: "runtime-exception",
          message: err.message,
          source: "application",
        },
      });
    });

    this.page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") {
        const loc = msg.location()?.url ?? this.page.url();
        const isSameOrigin =
          this.target.allowedOrigins.length === 0 ||
          this.isUrlInAllowedOrigin(loc) ||
          loc === "about:blank";
        this.windowSignals.push({
          kind: "notification",
          detail: `Console error: ${msg.text()}`,
          inClickedSubtree: false,
          origin: loc,
          error: {
            code: "CONSOLE_ERROR",
            category: "console-error",
            message: msg.text(),
            source: isSameOrigin ? "application" : "third-party",
            origin: loc,
          },
        });
      }
    });

    this.page.on("response", (res: Response) => {
      const req = res.request();
      const redirectCheck = validateRedirectChain(req, this.target);
      if (!redirectCheck.allowed) {
        this.windowSignals.push({
          kind: "network-blocked",
          detail: redirectCheck.reason,
          inClickedSubtree: false,
          origin: res.url(),
          error: {
            code: "REDIRECT_BLOCKED",
            category: "safety-policy",
            message: redirectCheck.reason,
            source: "crawler",
            initiator: "page",
            blockedBy: "safety-policy",
            blocked: true,
            blockedByCrawler: true,
          },
        });
        return;
      }

      const status = res.status();
      if (status >= 500) {
        const sameOrigin = this.target.allowedOrigins.length === 0 || this.isUrlInAllowedOrigin(res.url());
        this.windowSignals.push({
          kind: "network-request",
          detail: `HTTP ${status} on ${req.method()} ${res.url()}`,
          inClickedSubtree: false,
          origin: res.url(),
          error: {
            code: `HTTP_${status}`,
            category: "http",
            message: `HTTP ${status} from ${res.url()}`,
            source: sameOrigin ? "application" : "third-party",
            statusCode: status,
            origin: res.url(),
          },
        });
      }
    });

    this.page.on("dialog", async (dialog: Dialog) => {
      const msg = dialog.message();
      const isErrorPopup = ERROR_TOAST_HINTS.some((h) => msg.toLowerCase().includes(h));
      this.windowSignals.push({
        kind: "dialog",
        detail: `${dialog.type()}: ${msg}`,
        inClickedSubtree: false,
        ...(isErrorPopup
          ? {
              error: {
                code: "POPUP_ERROR",
                category: "popup-dialog",
                message: msg,
                source: "application",
              },
            }
          : {}),
      });
      await dialog.dismiss().catch(() => {});
    });

    this.page.on("popup", async (popup: Page) => {
      const popupUrl = popup.url();
      const check = evaluateHttpRequestSafety(popupUrl, "GET", this.target);
      this.windowSignals.push({
        kind: "popup",
        detail: check.allowed ? `Popup opened: ${popupUrl}` : `External popup blocked: ${popupUrl}`,
        inClickedSubtree: false,
      });
      await popup.close().catch(() => {});
    });

    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page.mainFrame()) return;
      const nextUrl = frame.url();
      if (nextUrl !== this.lastNavigatedUrl) {
        const check = evaluateHttpRequestSafety(nextUrl, "GET", this.target);
        if (!check.allowed) {
          this.windowSignals.push({
            kind: "network-blocked",
            detail: `External navigation blocked: ${nextUrl}`,
            inClickedSubtree: false,
            error: {
              code: "EXTERNAL_NAVIGATION_BLOCKED",
              category: "safety-policy",
              message: check.reason,
              source: "crawler",
              initiator: "page",
              blockedBy: "safety-policy",
              blocked: true,
              blockedByCrawler: true,
            },
          });
        } else {
          this.windowSignals.push({
            kind: "navigation",
            detail: `Navigated to ${nextUrl}`,
            inClickedSubtree: false,
          });
        }
        this.lastNavigatedUrl = nextUrl;
      }
    });
  }

  pushSignal(signal: SignalEvent): void {
    this.windowSignals.push(signal);
  }

  async beginInteractionWindow(): Promise<void> {
    this.windowSignals = [];
    this.lastNavigatedUrl = this.page.url();
    const existing = await this.readPortalEvents().catch(() => []);
    this.preClickNotificationTexts = new Set(existing.map((e) => e.text));
    await this.clearPortalEvents().catch(() => {});
  }

  async collectWindowSignals(nodeKey: string): Promise<SignalEvent[]> {
    const portalEvents = await this.readPortalEvents().catch(() => []);
    const seenInWindow = new Set<string>();

    for (const evt of portalEvents) {
      if (this.preClickNotificationTexts.has(evt.text) || seenInWindow.has(evt.text)) {
        continue;
      }
      seenInWindow.add(evt.text);

      const lower = evt.text.toLowerCase();
      const looksLikeError = ERROR_TOAST_HINTS.some((h) => lower.includes(h));
      this.windowSignals.push({
        kind: "notification",
        targetKey: nodeKey,
        detail: `Portal ${evt.role}: ${evt.text}`,
        inClickedSubtree: false,
        ...(looksLikeError
          ? {
              error: {
                code: "PORTAL_ERROR_TOAST",
                category: "ui-notification",
                message: evt.text,
                source: "application",
              },
            }
          : {}),
      });
    }

    await this.clearPortalEvents().catch(() => {});
    const hasSafetyBlock = this.windowSignals.some((s) => s.kind === "network-blocked");
    if (!hasSafetyBlock) {
      return [...this.windowSignals];
    }

    // Never attribute browser console/network-abort noise from our own safety block as an app FAIL
    return this.windowSignals.map((sig) => {
      const isBlockedConsoleNoise =
        sig.error?.code === "CONSOLE_ERROR" &&
        (sig.error.message.includes("ERR_FAILED") ||
          sig.error.message.includes("ERR_BLOCKED_BY_CLIENT") ||
          sig.error.message.includes("Failed to load resource") ||
          sig.error.message.includes("WebSocket connection"));
      const isBlockedFetchError =
        sig.error?.code === "JS_EXCEPTION" &&
        (sig.error.message.includes("Failed to fetch") ||
          sig.error.message.includes("Load failed") ||
          sig.error.message.includes("NetworkError"));

      if (sig.error !== undefined && (isBlockedConsoleNoise || isBlockedFetchError)) {
        return {
          ...sig,
          error: {
            ...sig.error,
            source: "crawler",
            initiator: "page",
            blockedBy: "safety-policy",
            blocked: true,
            blockedByCrawler: true,
          },
        };
      }
      return sig;
    });
  }

  private async readPortalEvents(): Promise<PortalMutationRecord[]> {
    return this.page.evaluate(() => {
      const w = window as unknown as { __dpPortalEvents?: PortalMutationRecord[] };
      return Array.isArray(w.__dpPortalEvents) ? w.__dpPortalEvents : [];
    });
  }

  private async clearPortalEvents(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as unknown as { __dpPortalEvents?: PortalMutationRecord[] };
      w.__dpPortalEvents = [];
    });
  }

  private isUrlInAllowedOrigin(rawUrl: string): boolean {
    try {
      return this.target.allowedOrigins.includes(new URL(rawUrl).origin);
    } catch {
      return false;
    }
  }
}
