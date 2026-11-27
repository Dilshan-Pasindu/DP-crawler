import { describe, expect, it } from "vitest";
import { compareWithBaseline, generateAcceptSuggestion, type BaselineFile } from "../../src/brain/baseline.js";
import { assessNodeConfidence } from "../../src/brain/confidence.js";
import { attributeError, correlateSignals } from "../../src/brain/correlation.js";
import { mergeDiscovery } from "../../src/brain/discovery.js";
import { classifyOutcome } from "../../src/brain/outcome.js";
import { redactText } from "../../src/brain/redact.js";
import { renderHtmlReport } from "../../src/brain/report/html.js";
import { renderMarkdownReport } from "../../src/brain/report/markdown.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { parseConfig } from "../../src/config.js";
import { makeDefaultTarget, makeMockNode, MockAdapter } from "../helpers/mock-adapter.js";

describe("Brain unit suites", () => {
  it("merges discovery only with corroborating evidence and never solely on identical text", () => {
    const primaryA = makeMockNode({
      role: "button",
      name: "Save",
      context: "/form-a",
      testId: "save-a",
      bounds: { x: 10, y: 10, width: 80, height: 30 },
    });
    const ocrCandidateDifferentCtx = makeMockNode({
      role: "button",
      name: "Save",
      context: "/form-b",
      discoverySources: ["ocr"],
      bounds: { x: 10, y: 10, width: 80, height: 30 },
    });
    const ocrCandidateMatch = makeMockNode({
      role: "button",
      name: "Save",
      context: "/form-a",
      discoverySources: ["ocr"],
      bounds: { x: 12, y: 11, width: 78, height: 29 },
    });

    const merged = mergeDiscovery([primaryA], [ocrCandidateDifferentCtx, ocrCandidateMatch]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.discoverySources).toEqual(["dom", "ocr"]);
  });

  it("keeps confidence dimensions separate", () => {
    const node = makeMockNode({
      role: "button",
      name: "Open",
      context: "/",
      testId: "open-btn",
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    });
    const conf = assessNodeConfidence(node, { unstable: true });
    expect(conf.identityConfidence).toBe("HIGH");
    expect(conf.visibilityConfidence).toBe("LOW");
    expect(conf.stateStabilityConfidence).toBe("LOW");
  });

  it("does not attribute crawler-blocked, background, third-party, or uncontexted 404 errors as FAIL", () => {
    expect(
      attributeError({
        code: "BLOCKED",
        category: "network",
        message: "Blocked by safety guard",
        source: "crawler",
        blockedByCrawler: true,
      }).attributable,
    ).toBe(false);

    expect(
      attributeError({
        code: "HTTP_404",
        category: "http",
        message: "Not found",
        source: "unknown",
        statusCode: 404,
      }).attributable,
    ).toBe(false);

    expect(
      attributeError({
        code: "HTTP_500",
        category: "http",
        message: "Internal error",
        source: "application",
        statusCode: 500,
      }).attributable,
    ).toBe(true);
  });

  it("correlates portal toast notifications outside the clicked subtree", () => {
    const obs = correlateSignals("el_btn", {
      attempted: true,
      succeeded: true,
      obscured: false,
      unstable: false,
      signals: [
        {
          kind: "notification",
          detail: "Toast rendered in body portal: Settings updated",
          inClickedSubtree: false,
        },
      ],
    });
    expect(obs.changeDetected).toBe(true);
    expect(obs.changeCorrelated).toBe(true);
    expect(classifyOutcome(obs, true).outcome).toBe("PASS");
  });

  it("classifies unstable controls as NOT_TESTED and dead controls as DEAD", () => {
    const unstableObs = correlateSignals("el_1", {
      attempted: false,
      succeeded: false,
      obscured: false,
      unstable: true,
      unsupportedReason: "unstable-control",
      signals: [],
    });
    expect(classifyOutcome(unstableObs, true)).toEqual({
      outcome: "NOT_TESTED",
      reason: "unstable-control",
    });

    const deadObs = correlateSignals("el_2", {
      attempted: true,
      succeeded: true,
      obscured: false,
      unstable: false,
      signals: [],
    });
    expect(classifyOutcome(deadObs, true).outcome).toBe("DEAD");
  });

  it("redacts emails, JWTs, bearer tokens, API keys, and query strings", () => {
    const raw =
      "User alice@example.com failed with Bearer secret_token_12345 jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.sig123456789 on https://app.local/reset?token=xyz";
    const redacted = redactText(raw);
    expect(redacted).not.toContain("alice@example.com");
    expect(redacted).not.toContain("secret_token_12345");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("token=xyz");
  });

  it("enforces baseline rules: LOW confidence becomes REVIEW_REQUIRED and incomplete runs never mark FIXED_CANDIDATE", () => {
    const baseline: BaselineFile = {
      schemaVersion: "1.0.0",
      entries: [
        {
          findingId: "find_old",
          elementKey: "el_old",
          category: "application-error",
          reason: "Known bug",
          acceptedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const lowConfFinding = {
      id: "find_low",
      category: "dead-control" as const,
      severity: "LOW" as const,
      status: "NEW" as const,
      targetId: "t1",
      elementKey: "el_low",
      elementName: "Mystery",
      elementRole: "button",
      identityConfidence: "LOW" as const,
      outcome: "DEAD" as const,
      reproductionPath: [],
      errorSummary: "No reaction",
      attributionConfidence: "LOW" as const,
      confirmed: false,
      limitations: [],
      signature: {
        category: "dead-control" as const,
        elementKey: "el_low",
        targetId: "t1",
        pageContext: "/",
        errorClassification: "DEAD",
        normalizedErrorMessage: "no reaction",
        interactionContext: "invoke",
      },
    };

    const result = compareWithBaseline({
      findings: [lowConfFinding],
      baseline,
      completionStatus: "LIMIT_REACHED",
      testedOrFailedElementKeys: new Set(["el_old"]),
    });

    expect(result.findings[0]?.status).toBe("REVIEW_REQUIRED");
    expect(result.fixedCandidates).toHaveLength(0);
    expect(result.reviewRequiredBaselineEntries).toHaveLength(1);
  });

  it("validates configuration with Zod and fails on invalid profiles", () => {
    expect(() =>
      parseConfig({
        profiles: {
          bad: {
            target: { platform: "web" }, // missing startUrl and entryPoint
          },
        },
      }),
    ).toThrow();
  });

  it("escapes hostile HTML/Markdown labels and renders offline HTML with CSP", async () => {
    const hostileBtn = makeMockNode({
      role: "button",
      name: `<script>alert("xss")</script>[click](javascript:alert(1))`,
      context: "/home",
      testId: "hostile-btn",
    });

    const adapter = new MockAdapter({
      scenario: {
        initialLocation: "/home",
        nodesByLocation: { "/home": [hostileBtn] },
        actionHandlers: {
          [hostileBtn.key]: () => ({
            attempted: true,
            succeeded: true,
            obscured: false,
            unstable: false,
            signals: [], // DEAD finding so it renders in findings
          }),
        },
      },
    });

    const report = await runCrawl({
      adapter,
      target: makeDefaultTarget(),
      profile: "web-local",
      configHash: "cfg123",
      limits: {
        maxDepth: 3,
        maxInteractions: 50,
        maxRunMinutes: 5,
        maxElementRetries: 1,
        maxRediscoveryPerState: 3,
      },
      confirmationMode: "off",
    });

    const html = renderHtmlReport(report);
    const md = renderMarkdownReport(report);
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(md).not.toContain("<script>alert");
    expect(md).toContain("&lt;script&gt;");

    const accept = generateAcceptSuggestion(report.findings, "2026-11-27T00:00:00.000Z");
    expect(accept.baselineEntries).toHaveLength(1);
  });
});
