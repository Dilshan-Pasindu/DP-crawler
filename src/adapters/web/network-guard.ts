import type { BrowserContext, Request, Route, WebSocketRoute } from "playwright";
import type { SignalEvent, TargetDescriptor } from "../../model/index.js";

const DEFAULT_DENIED_PAYMENT_SEGMENTS = [
  "/checkout",
  "/payment",
  "/payments",
  "/pay",
  "/billing/charge",
  "/stripe",
  "/paypal",
];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MUTATING_GET_HINTS = [
  "delete",
  "remove",
  "destroy",
  "erase",
  "reset",
  "clear",
  "deactivate",
  "checkout",
  "purchase",
  "pay",
  "unsubscribe",
  "logout",
  "signout",
  "sign-out",
  "transfer",
  "mutate",
];

export interface NetworkGuardCheck {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Evaluates whether an HTTP request URL and method are permitted under target safety rules.
 * Used both by Playwright context routing and standalone APIRequestContext validation.
 */
export function evaluateHttpRequestSafety(
  rawUrl: string,
  method: string,
  target: TargetDescriptor,
): NetworkGuardCheck {
  const upperMethod = method.toUpperCase();
  if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || rawUrl === "about:blank") {
    return { allowed: true, reason: "Inline non-network URL" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Malformed URL blocked: ${rawUrl}` };
  }

  if (target.allowedOrigins.length > 0 && !target.allowedOrigins.includes(parsed.origin)) {
    return { allowed: false, reason: `Cross-origin request blocked: ${parsed.origin}` };
  }

  const lowerPath = parsed.pathname.toLowerCase();
  for (const denied of target.safety.network.denyEndpoints) {
    if (lowerPath.includes(denied.endpoint.toLowerCase())) {
      return { allowed: false, reason: `Denied endpoint (${denied.reason}): ${parsed.pathname}` };
    }
  }

  for (const paymentSeg of DEFAULT_DENIED_PAYMENT_SEGMENTS) {
    if (lowerPath.includes(paymentSeg)) {
      return { allowed: false, reason: `Payment/checkout endpoint denied by default: ${parsed.pathname}` };
    }
  }

  const isExplicitlyAllowedMutation = target.safety.network.allowHttpMutations.some(
    (rule) =>
      rule.method.toUpperCase() === upperMethod &&
      lowerPath.includes(rule.endpoint.toLowerCase()),
  );

  if (isExplicitlyAllowedMutation) {
    const envVerified =
      target.safety.verificationLevel === "HIGH" || target.safety.verificationLevel === "MEDIUM";
    if (!envVerified && !target.safety.allowMutationsOnVerifiedEnv) {
      return {
        allowed: false,
        reason: `Allowlisted mutation blocked on unverified environment: ${upperMethod} ${parsed.pathname}`,
      };
    }
    return { allowed: true, reason: "Explicitly allowlisted mutation" };
  }

  if (MUTATING_METHODS.has(upperMethod)) {
    return { allowed: false, reason: `Unknown HTTP mutation blocked: ${upperMethod} ${parsed.pathname}` };
  }

  // Never assume GET is read-only
  if (upperMethod === "GET") {
    const fullLower = `${lowerPath}${parsed.search.toLowerCase()}`;
    const hint = MUTATING_GET_HINTS.find((h) => fullLower.includes(h));
    if (hint !== undefined) {
      return {
        allowed: false,
        reason: `Potentially mutating GET blocked (${hint}): ${parsed.pathname}`,
      };
    }
  }

  return { allowed: true, reason: "Allowed read-only same-origin request" };
}

/**
 * Evaluates whether a WebSocket endpoint is explicitly allowlisted.
 */
export function evaluateWebSocketSafety(rawUrl: string, target: TargetDescriptor): NetworkGuardCheck {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Invalid WebSocket URL blocked: ${rawUrl}` };
  }

  const allowed = target.safety.network.allowWebSocketConnections.some((rule) =>
    parsed.href.toLowerCase().includes(rule.endpoint.toLowerCase()),
  );
  if (!allowed) {
    return {
      allowed: false,
      reason: `Unapproved WebSocket connection blocked: ${parsed.origin}${parsed.pathname}`,
    };
  }
  return { allowed: true, reason: "Explicitly allowlisted WebSocket connection" };
}

/**
 * Validates all redirect hops on a request chain against target safety rules.
 */
export function validateRedirectChain(request: Request, target: TargetDescriptor): NetworkGuardCheck {
  let current: Request | null = request;
  while (current !== null) {
    const check = evaluateHttpRequestSafety(current.url(), current.method(), target);
    if (!check.allowed) {
      return { allowed: false, reason: `Redirect chain blocked: ${check.reason}` };
    }
    current = current.redirectedFrom();
  }
  return { allowed: true, reason: "Redirect chain verified" };
}

/**
 * Installs HTTP and WebSocket safety guards on a Playwright BrowserContext
 * BEFORE any page creation or navigation occurs.
 */
export async function installNetworkGuard(
  context: BrowserContext,
  target: TargetDescriptor,
  recordSignal: (signal: SignalEvent) => void,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const req = route.request();
    const check = evaluateHttpRequestSafety(req.url(), req.method(), target);
    if (!check.allowed) {
      recordSignal({
        kind: "network-blocked",
        detail: check.reason,
        inClickedSubtree: false,
        origin: safeOrigin(req.url()),
        error: {
          code: "NETWORK_GUARD_BLOCKED",
          category: "safety-policy",
          message: check.reason,
          source: "crawler",
          initiator: "page",
          blockedBy: "safety-policy",
          blocked: true,
          blockedByCrawler: true,
          origin: safeOrigin(req.url()),
        },
      });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  await context.routeWebSocket("**/*", async (ws: WebSocketRoute) => {
    const check = evaluateWebSocketSafety(ws.url(), target);
    if (!check.allowed) {
      recordSignal({
        kind: "network-blocked",
        detail: check.reason,
        inClickedSubtree: false,
        origin: safeOrigin(ws.url()),
        error: {
          code: "WEBSOCKET_GUARD_BLOCKED",
          category: "safety-policy",
          message: check.reason,
          source: "crawler",
          initiator: "page",
          blockedBy: "safety-policy",
          blocked: true,
          blockedByCrawler: true,
          origin: safeOrigin(ws.url()),
        },
      });
      await ws.close({ code: 1008, reason: "Blocked by DP Crawler safety policy" });
      return;
    }
    ws.connectToServer();
  });
}

function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "unknown";
  }
}
