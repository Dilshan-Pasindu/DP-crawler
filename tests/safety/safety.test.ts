import { describe, expect, it } from "vitest";
import { runCrawl } from "../../src/brain/crawler.js";
import {
  classifyRiskyAction,
  DEFAULT_RISKY_TERMS,
  evaluateSafety,
  normalizeForRiskMatch,
} from "../../src/brain/safety.js";
import { makeDefaultTarget, makeMockNode, MockAdapter } from "../helpers/mock-adapter.js";

describe("Safety engine", () => {
  it("normalizes camelCase, hyphens, underscores, slashes, and punctuation", () => {
    expect(normalizeForRiskMatch("deleteUserAccount")).toBe("delete user account");
    expect(normalizeForRiskMatch("cancel_subscription-now/yes!")).toBe("cancel subscription now yes");
  });

  it("blocks every default risky keyword from Section 9.2", () => {
    const target = makeDefaultTarget();
    const adapter = new MockAdapter({ scenario: { initialLocation: "/", nodesByLocation: {} } });

    for (const term of DEFAULT_RISKY_TERMS) {
      const node = makeMockNode({
        role: "button",
        name: `Action ${term} now`,
        context: "/settings",
        testId: `btn-${term.replace(/\s+/g, "-")}`,
      });
      const result = evaluateSafety({
        target,
        node,
        action: { type: "invoke" },
        capabilities: adapter.info.capabilities,
      });
      expect(result.allowed, `Expected "${term}" to be blocked`).toBe(false);
    }
  });

  it("uses whole-word matching so benign substrings like 'presets' are not misclassified as 'reset'", () => {
    const node = makeMockNode({
      role: "button",
      name: "View Presets",
      context: "/dashboard",
      testId: "view-presets",
    });
    const risk = classifyRiskyAction(node, { type: "invoke" });
    expect(risk.risky).toBe(false);
  });

  it("detects risky metadata on tooltip, elementId, or destination even when label looks benign", () => {
    const target = makeDefaultTarget();
    const adapter = new MockAdapter({ scenario: { initialLocation: "/", nodesByLocation: {} } });
    const deceptiveNode = makeMockNode({
      role: "button",
      name: "Continue",
      context: "/cart",
      elementId: "placeOrderBtn",
      destination: "/api/checkout/confirm",
    });

    const result = evaluateSafety({
      target,
      node: deceptiveNode,
      action: { type: "invoke" },
      capabilities: adapter.info.capabilities,
    });
    expect(result.allowed).toBe(false);
  });

  it("enforces rule precedence: global > target > profile > mandatory > default > exact exception", () => {
    const adapter = new MockAdapter({ scenario: { initialLocation: "/", nodesByLocation: {} } });
    const node = makeMockNode({
      role: "button",
      name: "Archive Report",
      context: "/reports",
      testId: "archive-btn",
    });

    // Global deny overrides exact exception
    const targetGlobalDeny = makeDefaultTarget({
      safety: {
        ...makeDefaultTarget().safety,
        verificationLevel: "HIGH",
        allowMutationsOnVerifiedEnv: true,
        globalDenyTerms: ["archive"],
        exceptions: [{ locatorKey: node.key, action: "invoke", reason: "Reviewed safe fixture" }],
      },
    });
    const res1 = evaluateSafety({
      target: targetGlobalDeny,
      node,
      action: { type: "invoke" },
      capabilities: adapter.info.capabilities,
    });
    expect(res1.allowed).toBe(false);
    expect(res1.ruleLayer).toBe("global-deny");

    // Exact exception works when no higher deny layer triggers and env is verified
    const targetException = makeDefaultTarget({
      safety: {
        ...makeDefaultTarget().safety,
        verificationLevel: "HIGH",
        allowMutationsOnVerifiedEnv: true,
        exceptions: [{ locatorKey: node.key, action: "invoke", reason: "Reviewed safe fixture" }],
      },
    });
    const res2 = evaluateSafety({
      target: targetException,
      node,
      action: { type: "invoke" },
      capabilities: adapter.info.capabilities,
    });
    expect(res2.allowed).toBe(true);
    expect(res2.ruleLayer).toBe("exception");

    // Exception does NOT unlock unrelated elements
    const otherNode = makeMockNode({
      role: "button",
      name: "Delete Account",
      context: "/reports",
      testId: "delete-btn",
    });
    const res3 = evaluateSafety({
      target: targetException,
      node: otherNode,
      action: { type: "invoke" },
      capabilities: adapter.info.capabilities,
    });
    expect(res3.allowed).toBe(false);
  });

  it("blocks remote targets without confirmRemote, external origins, and LOW identity confidence", () => {
    const adapter = new MockAdapter({ scenario: { initialLocation: "/", nodesByLocation: {} } });
    const safeNode = makeMockNode({ role: "button", name: "Help", context: "/", testId: "help-btn" });

    expect(
      evaluateSafety({
        target: makeDefaultTarget({ isRemote: true }),
        node: safeNode,
        action: { type: "invoke" },
        capabilities: adapter.info.capabilities,
      }).allowed,
    ).toBe(false);

    const extNode = makeMockNode({
      role: "link",
      name: "Docs",
      context: "/",
      testId: "ext-docs",
      destination: "https://evil.example.com/phish",
    });
    expect(
      evaluateSafety({
        target: makeDefaultTarget(),
        node: extNode,
        action: { type: "invoke" },
        capabilities: adapter.info.capabilities,
      }).allowed,
    ).toBe(false);

    const lowConfNode = makeMockNode({
      role: "button",
      name: "Help",
      context: "/",
      identityConfidence: "LOW",
    });
    expect(
      evaluateSafety({
        target: makeDefaultTarget(),
        node: lowConfNode,
        action: { type: "invoke" },
        capabilities: adapter.info.capabilities,
      }).allowed,
    ).toBe(false);
  });

  it("returns RUN_BLOCKED when a required safety protection is unavailable", async () => {
    const safeNode = makeMockNode({ role: "button", name: "Help", context: "/", testId: "help-btn" });
    let executed = false;
    const adapter = new MockAdapter({
      scenario: {
        initialLocation: "/",
        nodesByLocation: { "/": [safeNode] },
        protections: [{ name: "http-interception", active: false, required: true, reason: "Unavailable" }],
        actionHandlers: {
          [safeNode.key]: () => {
            executed = true;
            return { attempted: true, succeeded: true, obscured: false, unstable: false, signals: [] };
          },
        },
      },
    });

    const report = await runCrawl({
      adapter,
      target: makeDefaultTarget(),
      profile: "test",
      configHash: "abc123",
      limits: {
        maxDepth: 3,
        maxInteractions: 50,
        maxRunMinutes: 5,
        maxElementRetries: 1,
        maxRediscoveryPerState: 3,
      },
      confirmationMode: "off",
    });

    expect(report.completionStatus).toBe("RUN_BLOCKED");
    expect(executed).toBe(false);
    expect(report.safetyCoverage.fullCoverage).toBe(false);
  });
});
