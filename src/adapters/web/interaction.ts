/// <reference lib="dom" />
import type { Locator, Page } from "playwright";
import { normalizeName } from "../../brain/identity.js";
import type { InteractionExecutionResult, UIAction, UniversalNode } from "../../model/index.js";
import { extractCurrentNodes } from "./discovery.js";
import type { WebSignalCollector } from "./signals.js";

function escapeCssIdent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/**
 * Resolves a UniversalNode to a unique Playwright Locator following Section 8.3 priority:
 * 1. data-testid
 * 2. stable DOM id
 * 3. ARIA role + accessible name
 * 4. label + parent context
 * 5. exact text
 * 6. fallback CSS selector
 */
export async function resolveUniqueWebLocator(
  page: Page,
  node: UniversalNode,
): Promise<{ readonly locator: Locator; readonly strategy: string } | null> {
  const candidates: Array<{ readonly strategy: string; readonly locator: Locator }> = [];

  if (node.testId !== undefined && node.testId.length > 0) {
    candidates.push({
      strategy: "data-testid",
      locator: page.getByTestId(node.testId),
    });
  }

  if (node.elementId !== undefined && node.elementId.length > 0) {
    candidates.push({
      strategy: "dom-id",
      locator: page.locator(`#${escapeCssIdent(node.elementId)}`),
    });
  }

  if (node.name.trim().length > 0) {
    const validRoles = ["button", "link", "menuitem", "tab", "checkbox", "switch", "textbox", "combobox"] as const;
    if (validRoles.includes(node.role as (typeof validRoles)[number])) {
      candidates.push({
        strategy: "role-name",
        locator: page.getByRole(node.role as (typeof validRoles)[number], { name: node.name, exact: true }),
      });
    }
    candidates.push({
      strategy: "label",
      locator: page.getByLabel(node.name, { exact: true }),
    });
    candidates.push({
      strategy: "exact-text",
      locator: page.getByText(node.name, { exact: true }),
    });
  }

  if (node.ref.driverRef.length > 0) {
    candidates.push({
      strategy: "css-fallback",
      locator: page.locator(node.ref.driverRef),
    });
  }

  for (const candidate of candidates) {
    try {
      if ((await candidate.locator.count()) === 1) {
        return candidate;
      }
    } catch {
      // Try next locator strategy when selector syntax or frame state fails
    }
  }

  return null;
}

/**
 * Re-resolves a node and verifies it represents the same logical control.
 */
export async function resolveAndVerifyWebNode(
  page: Page,
  original: UniversalNode,
): Promise<UniversalNode | null> {
  const currentNodes = await extractCurrentNodes(page);
  const byKey = currentNodes.find((n) => n.key === original.key);
  if (byKey !== undefined) {
    return byKey;
  }

  const byIdentity = currentNodes.find(
    (n) =>
      normalizeName(n.role) === normalizeName(original.role) &&
      normalizeName(n.name) === normalizeName(original.name) &&
      normalizeName(n.context) === normalizeName(original.context),
  );
  return byIdentity ?? null;
}

/**
 * Checks whether the resolved locator is obscured at its hit point, accounting for
 * nested children and open shadow roots.
 */
async function checkLocatorObscured(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return true;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const deepElementFromPoint = (root: Document | ShadowRoot, x: number, y: number): Element | null => {
      const hit = root.elementFromPoint(x, y);
      if (!hit) return null;
      if (hit.shadowRoot) {
        const inner = deepElementFromPoint(hit.shadowRoot, x, y);
        return inner ?? hit;
      }
      return hit;
    };

    const hit = deepElementFromPoint(document, cx, cy);
    if (!hit) return true;
    return hit !== el && !el.contains(hit);
  });
}

/**
 * Executes a Playwright interaction safely without `force: true`:
 * resolve -> scrollIntoView -> visibility/enabled -> hit-test -> execute.
 */
export async function executeWebAction(params: {
  readonly page: Page;
  readonly node: UniversalNode;
  readonly action: UIAction;
  readonly signals: WebSignalCollector;
}): Promise<InteractionExecutionResult> {
  const { page, node, action, signals } = params;
  const resolved = await resolveUniqueWebLocator(page, node);
  if (resolved === null) {
    return {
      attempted: false,
      succeeded: false,
      obscured: false,
      unstable: true,
      dispatchMayHaveHappened: false,
      unsupportedReason: "unstable-control",
      signals: [],
    };
  }

  const { locator } = resolved;

  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
  } catch {
    return {
      attempted: false,
      succeeded: false,
      obscured: false,
      unstable: true,
      dispatchMayHaveHappened: false,
      unsupportedReason: "unstable-control",
      signals: [],
    };
  }

  const visible = await locator.isVisible().catch(() => false);
  const enabled = await locator.isEnabled().catch(() => false);
  if (!visible || !enabled) {
    return {
      attempted: false,
      succeeded: false,
      obscured: false,
      unstable: true,
      dispatchMayHaveHappened: false,
      unsupportedReason: "unstable-control",
      signals: [],
    };
  }

  const obscuredByHitTest = await checkLocatorObscured(locator).catch(() => false);
  if (obscuredByHitTest) {
    return {
      attempted: false,
      succeeded: false,
      obscured: true,
      unstable: false,
      dispatchMayHaveHappened: false,
      unsupportedReason: "Control is obscured by another element",
      signals: [],
    };
  }

  await signals.beginInteractionWindow();
  const preDomDigest = await page
    .evaluate(() => `${document.body?.innerText ?? ""}|${document.body?.innerHTML.length ?? 0}`)
    .catch(() => "");
  const preHtmlSig =
    (await locator.count().catch(() => 0)) === 1
      ? await locator.evaluate((el) => el.outerHTML.slice(0, 200)).catch(() => "")
      : "";
  const preUrl = page.url();
  let dispatchStarted = false;

  try {
    dispatchStarted = true;
    switch (action.type) {
      case "invoke":
      case "expand":
      case "collapse":
      case "toggle":
        await locator.click({ timeout: 2500 });
        break;
      case "setValue":
        await locator.fill(action.value, { timeout: 2500 });
        break;
      case "select":
        await locator.selectOption(action.value, { timeout: 2500 });
        break;
      case "focus":
        await locator.focus({ timeout: 2500 });
        break;
      case "scroll":
        await page.evaluate(
          (dir) => window.scrollBy(0, dir === "up" ? -300 : 300),
          action.direction ?? "down",
        );
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const collected = await signals.collectWindowSignals(node.key);
    const isPointerIntercept =
      message.includes("intercepts pointer events") || message.includes("obscured");

    if (isPointerIntercept) {
      return {
        attempted: false,
        succeeded: false,
        obscured: true,
        unstable: false,
        dispatchMayHaveHappened: false,
        unsupportedReason: "Control pointer events intercepted by another element",
        signals: collected,
      };
    }

    const isDetached =
      message.includes("detached") || message.includes("Target closed") || message.includes("not attached");
    return {
      attempted: true,
      succeeded: false,
      obscured: false,
      unstable: isDetached,
      dispatchMayHaveHappened: dispatchStarted,
      unsupportedReason: isDetached ? "unstable-control" : message,
      signals: collected,
    };
  }

  await page.waitForTimeout(150);
  const collected = await signals.collectWindowSignals(node.key);

  const postUrl = page.url();
  const postCount = await locator.count().catch(() => 0);
  const postHtmlSig =
    postCount === 1
      ? await locator.evaluate((el) => el.outerHTML.slice(0, 200)).catch(() => "")
      : "";
  const postDomDigest = await page
    .evaluate(() => `${document.body?.innerText ?? ""}|${document.body?.innerHTML.length ?? 0}`)
    .catch(() => "");

  if (postUrl === preUrl && ((postHtmlSig !== "" && postHtmlSig !== preHtmlSig) || postCount === 0)) {
    collected.push({
      kind: "dom-mutation",
      targetKey: node.key,
      detail:
        postCount === 0
          ? "Target element replaced or removed after interaction"
          : "Element DOM attributes/content updated after interaction",
      inClickedSubtree: true,
    });
  } else if (postUrl === preUrl && postDomDigest !== "" && postDomDigest !== preDomDigest) {
    collected.push({
      kind: "dom-mutation",
      targetKey: node.key,
      detail: "Page DOM state updated after interaction",
      inClickedSubtree: false,
    });
  }

  return {
    attempted: true,
    succeeded: true,
    obscured: false,
    unstable: false,
    dispatchMayHaveHappened: true,
    signals: collected,
  };
}
