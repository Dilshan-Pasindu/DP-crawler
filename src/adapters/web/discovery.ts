/// <reference lib="dom" />
import type { Page } from "playwright";
import { fingerprintState } from "../../brain/discovery.js";
import { buildElementKey, normalizeName } from "../../brain/identity.js";
import type {
  Bounds,
  IdentityConfidence,
  ScrollDiscoveryState,
  StateSnapshot,
  UniversalNode,
} from "../../model/index.js";

interface RawDomElement {
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly context: string;
  readonly testId?: string;
  readonly elementId?: string;
  readonly title?: string;
  readonly tooltip?: string;
  readonly destination?: string;
  readonly value?: string;
  readonly inputType?: string;
  readonly bounds?: Bounds;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly interactive: boolean;
  readonly supportedActions: string[];
  readonly weakIdentityHint: boolean;
  readonly driverSelector: string;
}

const EXTRACT_ELEMENTS_SCRIPT = `(() => {
  const selector = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[aria-expanded]',
    '[data-testid]'
  ].join(',');

  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const getContext = (el) => {
    const landmark = el.closest('main, nav, header, footer, form, dialog, [role="dialog"], [role="menu"], section');
    const path = window.location.pathname || '/';
    if (!landmark) return path;
    const lmId = landmark.getAttribute('data-testid') || landmark.id || landmark.getAttribute('aria-label') || landmark.tagName.toLowerCase();
    return path + '#' + lmId;
  };

  const getLabelledBy = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return '';
    return ids.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
  };

  const getAccessibleName = (el) => {
    const aria = el.getAttribute('aria-label') || getLabelledBy(el);
    if (aria && aria.trim()) return aria.trim();
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && label.textContent?.trim()) return label.textContent.trim();
    }
    const text = (el.textContent || '').trim();
    if (text) return text;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return (el.placeholder || el.value || '').trim();
    }
    return (el.getAttribute('title') || '').trim();
  };

  const inferRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      return 'textbox';
    }
    return tag;
  };

  const buildFallbackSelector = (el) => {
    if (el.getAttribute('data-testid')) {
      return '[data-testid="' + CSS.escape(el.getAttribute('data-testid')) + '"]';
    }
    if (el.id) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      const index = sameTagSiblings.indexOf(cur) + 1;
      parts.unshift(sameTagSiblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };

  const elements = Array.from(document.querySelectorAll(selector));
  return elements.map((el) => {
    const tag = el.tagName.toLowerCase();
    const role = inferRole(el);
    const name = getAccessibleName(el);
    const testId = el.getAttribute('data-testid') || undefined;
    const elementId = el.id || undefined;
    const title = el.getAttribute('title') || undefined;
    const tooltip = el.getAttribute('aria-description') || el.getAttribute('data-tooltip') || title;
    const destination = el.getAttribute('href') || el.getAttribute('formaction') || undefined;
    const rect = el.getBoundingClientRect();
    const visible = isVisible(el);
    const enabled = !(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
    const supportedActions = ['focus'];
    if (role === 'textbox' && tag !== 'button') {
      supportedActions.unshift('setValue');
    } else if (role === 'combobox') {
      supportedActions.unshift('select');
    } else if (role === 'checkbox' || role === 'switch') {
      supportedActions.unshift('toggle');
    } else if (el.hasAttribute('aria-expanded')) {
      supportedActions.unshift(el.getAttribute('aria-expanded') === 'true' ? 'collapse' : 'expand', 'invoke');
    } else {
      supportedActions.unshift('invoke');
    }

    const weakIdentityHint =
      el.hasAttribute('data-low-confidence') ||
      (!testId && !elementId && (!name || name.length <= 1 || /^item\\s*\\d+$/i.test(name)));

    return {
      tag,
      role,
      name,
      context: getContext(el),
      testId,
      elementId,
      title,
      tooltip,
      destination,
      value: 'value' in el && typeof el.value === 'string' ? el.value : undefined,
      inputType: tag === 'input' ? (el.getAttribute('type') || 'text') : undefined,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible,
      enabled,
      interactive: true,
      supportedActions,
      weakIdentityHint,
      driverSelector: buildFallbackSelector(el)
    };
  });
})()`;

function mapRawElementsToNodes(rawElements: readonly RawDomElement[]): UniversalNode[] {
  const duplicateTracker = new Map<string, number>();

  return rawElements.map((raw) => {
    const baseSig = `${normalizeName(raw.role)}|${normalizeName(raw.name)}|${normalizeName(raw.context)}`;
    const hasUniqueId =
      (raw.testId !== undefined && raw.testId.length > 0) ||
      (raw.elementId !== undefined && raw.elementId.length > 0);
    const count = (duplicateTracker.get(baseSig) ?? 0) + 1;
    duplicateTracker.set(baseSig, count);

    const ordinal = !hasUniqueId && count > 1 ? count : undefined;
    const key = buildElementKey({
      role: raw.role,
      name: raw.name,
      context: raw.context,
      ...(raw.testId !== undefined ? { testId: raw.testId } : {}),
      ...(raw.elementId !== undefined ? { elementId: raw.elementId } : {}),
      ...(ordinal !== undefined ? { ordinal } : {}),
    });

    const identityConfidence: IdentityConfidence =
      raw.weakIdentityHint
        ? "LOW"
        : hasUniqueId
          ? "HIGH"
          : raw.name.trim().length > 0
            ? "MEDIUM"
            : "LOW";

    return {
      key,
      role: raw.role,
      name: raw.name,
      context: raw.context,
      ...(raw.testId !== undefined ? { testId: raw.testId } : {}),
      ...(raw.elementId !== undefined ? { elementId: raw.elementId } : {}),
      ...(raw.title !== undefined ? { title: raw.title } : {}),
      ...(raw.tooltip !== undefined ? { tooltip: raw.tooltip } : {}),
      ...(raw.destination !== undefined ? { destination: raw.destination } : {}),
      ...(raw.value !== undefined ? { value: raw.value } : {}),
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(raw.bounds !== undefined ? { bounds: raw.bounds } : {}),
      visible: raw.visible,
      enabled: raw.enabled,
      interactive: raw.interactive,
      supportedActions: raw.supportedActions,
      identityConfidence,
      discoverySources: ["dom"],
      children: [],
      ref: {
        key,
        driverRef: raw.driverSelector,
      },
    };
  });
}

export async function extractCurrentNodes(page: Page): Promise<UniversalNode[]> {
  const raw = (await page.evaluate(EXTRACT_ELEMENTS_SCRIPT)) as RawDomElement[];
  return mapRawElementsToNodes(raw);
}

/**
 * Discovers DOM/ARIA nodes on the current page and performs bounded scrolling
 * when scrollable overflow exists, recording ScrollDiscoveryState accurately.
 */
export async function discoverWebSnapshot(
  page: Page,
  options?: { readonly maxScrollAttempts?: number; readonly maxNoNewStreak?: number },
): Promise<StateSnapshot> {
  const maxScrollAttempts = options?.maxScrollAttempts ?? 4;
  const maxNoNewStreak = options?.maxNoNewStreak ?? 2;
  const location = page.url();

  const initialNodes = await extractCurrentNodes(page);
  const byKey = new Map<string, UniversalNode>();
  for (const node of initialNodes) {
    byKey.set(node.key, node);
  }

  const canScroll = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 20,
  );

  let scrollState: ScrollDiscoveryState = {
    containerId: "window",
    scrollAttempts: 0,
    newNodeCount: 0,
    lastStateFingerprint: fingerprintState(location, [...byKey.values()]),
    scrollLimitReached: false,
    noNewNodesStreak: 0,
  };

  if (canScroll) {
    let attempts = 0;
    let streak = 0;
    let totalNew = 0;
    let lastFp = scrollState.lastStateFingerprint;
    let limitReached = false;

    while (attempts < maxScrollAttempts) {
      attempts += 1;
      await page.evaluate(() => window.scrollBy(0, Math.max(300, window.innerHeight * 0.8)));
      await page.waitForTimeout(80);

      const stepNodes = await extractCurrentNodes(page);
      let newlyAdded = 0;
      for (const n of stepNodes) {
        if (!byKey.has(n.key)) {
          byKey.set(n.key, n);
          newlyAdded += 1;
        }
      }
      totalNew += newlyAdded;
      const fp = fingerprintState(location, [...byKey.values()]);

      if (newlyAdded === 0 || fp === lastFp) {
        streak += 1;
      } else {
        streak = 0;
      }
      lastFp = fp;

      if (streak >= maxNoNewStreak) {
        break;
      }
      if (attempts === maxScrollAttempts && newlyAdded > 0) {
        limitReached = true;
      }
    }

    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    scrollState = {
      containerId: "window",
      scrollAttempts: attempts,
      newNodeCount: totalNew,
      lastStateFingerprint: lastFp,
      scrollLimitReached: limitReached,
      noNewNodesStreak: streak,
    };
  }

  const nodes = [...byKey.values()];
  return {
    location,
    stateHash: fingerprintState(location, nodes),
    nodes,
    scrollLimitReached: scrollState.scrollLimitReached,
    scrollStates: [scrollState],
  };
}
