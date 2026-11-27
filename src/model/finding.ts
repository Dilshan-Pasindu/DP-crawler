import type { Outcome } from "./outcome.js";
import type { IdentityConfidence } from "./universal-node.js";

/**
 * Baseline comparison status for a finding.
 */
export type FindingStatus =
  | "NEW"
  | "KNOWN"
  | "FIXED_CANDIDATE"
  | "REVIEW_REQUIRED";

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type FindingCategory =
  | "application-error"
  | "process-crash"
  | "flaky-control"
  | "obscured-control"
  | "dead-control"
  | "restore-failure";

/**
 * Canonical, timestamp-free fields used to compute a deterministic findingId.
 */
export interface FindingSignature {
  readonly category: FindingCategory;
  readonly elementKey: string;
  readonly targetId: string;
  readonly pageContext: string;
  readonly errorClassification: string;
  readonly normalizedErrorMessage: string;
  readonly interactionContext: string;
}

/**
 * Diagnostic finding emitted by the shared brain.
 */
export interface Finding {
  readonly id: string;
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly targetId: string;
  readonly elementKey: string;
  readonly elementName: string;
  readonly elementRole: string;
  readonly identityConfidence: IdentityConfidence;
  readonly outcome: Outcome;
  readonly reproductionPath: readonly string[];
  readonly errorSummary: string;
  readonly attributionConfidence: "HIGH" | "MEDIUM" | "LOW";
  readonly confirmed: boolean;
  readonly evidenceRef?: string;
  readonly limitations: readonly string[];
  readonly signature: FindingSignature;
}
