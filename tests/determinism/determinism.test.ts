import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildFindingId, compareWithBaseline } from "../../src/brain/baseline.js";
import { runCrawl } from "../../src/brain/crawler.js";
import { buildElementKey } from "../../src/brain/identity.js";
import { redactText } from "../../src/brain/redact.js";
import { renderJsonReport } from "../../src/brain/report/json.js";
import { matchWholeWordOrPhrase, normalizeForRiskMatch } from "../../src/brain/safety.js";
import { makeDefaultTarget, makeMockNode, MockAdapter } from "../helpers/mock-adapter.js";

describe("Determinism & property-based tests", () => {
  it("produces identical deterministic results across 10 consecutive crawl runs", async () => {
    const safeBtn = makeMockNode({ role: "button", name: "Details", context: "/items", testId: "details-btn" });
    const failingBtn = makeMockNode({ role: "button", name: "Load Stats", context: "/items", testId: "stats-btn" });
    const riskyBtn = makeMockNode({ role: "button", name: "Delete All", context: "/items", testId: "del-btn" });

    const snapshots: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      const adapter = new MockAdapter({
        scenario: {
          initialLocation: "/items",
          nodesByLocation: { "/items": [safeBtn, failingBtn, riskyBtn] },
          actionHandlers: {
            [failingBtn.key]: () => ({
              attempted: true,
              succeeded: true,
              obscured: false,
              unstable: false,
              signals: [
                {
                  kind: "network-request",
                  detail: "GET /api/stats -> 500",
                  inClickedSubtree: true,
                  error: {
                    code: "HTTP_500",
                    category: "http",
                    message: "Internal Server Error for user@example.com",
                    source: "application",
                    statusCode: 500,
                  },
                },
              ],
            }),
          },
        },
      });

      const report = await runCrawl({
        adapter,
        target: makeDefaultTarget(),
        profile: "det",
        configHash: "hash_fixed",
        limits: {
          maxDepth: 3,
          maxInteractions: 200,
          maxRunMinutes: 30,
          maxElementRetries: 1,
          maxRediscoveryPerState: 3,
        },
        confirmationMode: "failures",
        clock: {
          nowMs: () => 1_700_000_000_000 + i * 1000, // deliberately varied operational timestamp
          isoNow: () => `2026-11-27T00:00:0${i}.000Z`,
          generateRunId: () => `run_random_${i}`,
        },
      });

      // Strip operational metadata and compare deterministic report fields
      const { operational: _op, ...deterministicPart } = JSON.parse(renderJsonReport(report)) as Record<string, unknown>;
      snapshots.push(JSON.stringify(deterministicPart));
    }

    for (let i = 1; i < snapshots.length; i += 1) {
      expect(snapshots[i]).toBe(snapshots[0]);
    }
  });

  it("property: element keys and finding IDs are deterministic and ignore secrets after redaction", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (role, name, context) => {
          const k1 = buildElementKey({ role, name, context });
          const k2 = buildElementKey({ role, name, context });
          expect(k1).toBe(k2);
          expect(k1.startsWith("el_")).toBe(true);

          const f1 = buildFindingId({
            category: "application-error",
            elementKey: k1,
            targetId: "app",
            pageContext: context,
            errorClassification: "HTTP_500",
            normalizedErrorMessage: "Failed",
            interactionContext: "invoke",
          });
          const f2 = buildFindingId({
            category: "application-error",
            elementKey: k1,
            targetId: "app",
            pageContext: context,
            errorClassification: "HTTP_500",
            normalizedErrorMessage: "Failed",
            interactionContext: "invoke",
          });
          expect(f1).toBe(f2);
        },
      ),
    );
  });

  it("property: normalizeForRiskMatch is idempotent and redaction removes email patterns", () => {
    fc.assert(
      fc.property(fc.string(), fc.emailAddress(), (raw, email) => {
        const once = normalizeForRiskMatch(raw);
        const twice = normalizeForRiskMatch(once);
        expect(twice).toBe(once);
        expect(matchWholeWordOrPhrase(once, "")).toBe(false);

        const redacted = redactText(`Contact ${email} now`);
        expect(redacted).not.toContain(email);
      }),
    );
  });

  it("property: LOW identity confidence findings never auto-classify as NEW or FIXED_CANDIDATE", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (idSuffix) => {
        const res = compareWithBaseline({
          findings: [
            {
              id: `find_${idSuffix}`,
              category: "dead-control",
              severity: "LOW",
              status: "NEW",
              targetId: "t",
              elementKey: `el_${idSuffix}`,
              elementName: "Item",
              elementRole: "button",
              identityConfidence: "LOW",
              outcome: "DEAD",
              reproductionPath: [],
              errorSummary: "dead",
              attributionConfidence: "LOW",
              confirmed: false,
              limitations: [],
              signature: {
                category: "dead-control",
                elementKey: `el_${idSuffix}`,
                targetId: "t",
                pageContext: "/",
                errorClassification: "DEAD",
                normalizedErrorMessage: "dead",
                interactionContext: "invoke",
              },
            },
          ],
          baseline: undefined,
          completionStatus: "COMPLETED",
          testedOrFailedElementKeys: new Set(),
        });
        expect(res.findings[0]?.status).toBe("REVIEW_REQUIRED");
      }),
    );
  });
});
