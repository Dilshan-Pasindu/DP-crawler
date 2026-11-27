import { createHash } from "node:crypto";
import type {
  CompletionStatus,
  Finding,
  FindingSignature,
  FindingStatus,
  SafetyExceptionRule,
} from "../model/index.js";
import { normalizeName } from "./identity.js";
import { redactText } from "./redact.js";

/**
 * Reviewed baseline schema stored by human operators.
 */
export interface BaselineFile {
  readonly schemaVersion: string;
  readonly entries: readonly BaselineEntry[];
}

export interface BaselineEntry {
  readonly findingId: string;
  readonly elementKey: string;
  readonly category: string;
  readonly reason: string;
  readonly acceptedAt: string;
}

/**
 * Computes a stable finding ID from canonical, timestamp-free signature fields.
 * Excludes timestamps, durations, run IDs, native handles, coordinates, and secrets.
 */
export function buildFindingId(signature: FindingSignature): string {
  const canonical = {
    category: signature.category,
    elementKey: signature.elementKey,
    targetId: signature.targetId,
    pageContext: normalizeName(redactText(signature.pageContext)),
    errorClassification: normalizeName(signature.errorClassification),
    normalizedErrorMessage: normalizeName(redactText(signature.normalizedErrorMessage)),
    interactionContext: normalizeName(redactText(signature.interactionContext)),
  };
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
  return `find_${digest}`;
}

export interface BaselineComparisonResult {
  readonly findings: readonly Finding[];
  readonly fixedCandidates: readonly BaselineEntry[];
  readonly reviewRequiredBaselineEntries: readonly BaselineEntry[];
}

/**
 * Compares current findings against a reviewed baseline.
 * LOW-confidence findings are always marked REVIEW_REQUIRED (never NEW or FIXED).
 * Baseline entries absent from the current run become FIXED_CANDIDATE only when
 * coverage completed without blocked/untested truncation.
 */
export function compareWithBaseline(params: {
  readonly findings: readonly Finding[];
  readonly baseline: BaselineFile | undefined;
  readonly completionStatus: CompletionStatus;
  readonly testedOrFailedElementKeys: ReadonlySet<string>;
}): BaselineComparisonResult {
  const { findings, baseline, completionStatus, testedOrFailedElementKeys } = params;
  const knownIds = new Set(baseline?.entries.map((e) => e.findingId) ?? []);

  const updatedFindings: Finding[] = findings.map((finding) => {
    if (finding.identityConfidence === "LOW") {
      return { ...finding, status: "REVIEW_REQUIRED" satisfies FindingStatus };
    }
    const status: FindingStatus = knownIds.has(finding.id) ? "KNOWN" : "NEW";
    return { ...finding, status };
  });

  const currentIds = new Set(updatedFindings.map((f) => f.id));
  const fixedCandidates: BaselineEntry[] = [];
  const reviewRequiredBaselineEntries: BaselineEntry[] = [];

  for (const entry of baseline?.entries ?? []) {
    if (currentIds.has(entry.findingId)) {
      continue;
    }
    const sufficientlyTested =
      completionStatus === "COMPLETED" && testedOrFailedElementKeys.has(entry.elementKey);
    if (sufficientlyTested) {
      fixedCandidates.push(entry);
    } else {
      reviewRequiredBaselineEntries.push(entry);
    }
  }

  return {
    findings: updatedFindings,
    fixedCandidates,
    reviewRequiredBaselineEntries,
  };
}

export interface SuggestedAcceptanceOutput {
  readonly schemaVersion: string;
  readonly note: string;
  readonly baselineEntries: readonly BaselineEntry[];
  readonly suggestedExceptions: readonly SafetyExceptionRule[];
}

/**
 * Generates suggested baseline entries for human review without modifying any baseline file.
 */
export function generateAcceptSuggestion(
  findings: readonly Finding[],
  generatedAt: string,
): SuggestedAcceptanceOutput {
  const baselineEntries: BaselineEntry[] = findings
    .filter((f) => f.identityConfidence !== "LOW")
    .map((f) => ({
      findingId: f.id,
      elementKey: f.elementKey,
      category: f.category,
      reason: `Reviewed finding (${f.category}): ${redactText(f.errorSummary)}`,
      acceptedAt: generatedAt,
    }));

  return {
    schemaVersion: "1.0.0",
    note: "Human review required before adding entries to baseline. DP Crawler never silently accepts findings.",
    baselineEntries,
    suggestedExceptions: [],
  };
}
