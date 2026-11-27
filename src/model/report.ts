import type { UIAction } from "./actions.js";
import type { AdapterInfo } from "./capabilities.js";
import type { Finding } from "./finding.js";
import type { ErrorRecord, InteractionObservation, Outcome } from "./outcome.js";
import type { SafetyCoverageReport } from "./session.js";
import type { Platform, TestEnvVerificationLevel } from "./target.js";
import type { IdentityConfidence } from "./universal-node.js";

export type CompletionStatus = "COMPLETED" | "LIMIT_REACHED" | "RUN_BLOCKED";

/**
 * Explicit typed coverage counters (never reduced to an ungrounded percentage).
 */
export interface CoverageReport {
  readonly discovered: number;
  readonly tested: number;
  readonly blocked: number;
  readonly notTested: number;
  readonly failed: number;
  readonly flaky: number;
  readonly obscured: number;
  readonly dead: number;
  readonly unvisited: number;
  readonly reachedDepth: number;
  readonly scrollLimitReached: boolean;
  readonly rediscoveryCount: number;
}

/**
 * Per-element outcome entry recorded in the authoritative report.
 */
export interface ElementOutcomeRecord {
  readonly elementKey: string;
  readonly name: string;
  readonly role: string;
  readonly context: string;
  readonly identityConfidence: IdentityConfidence;
  readonly action?: UIAction;
  readonly outcome: Outcome;
  readonly reason?: string;
  readonly observation: InteractionObservation;
  readonly evidenceRef?: string;
}

/**
 * Non-deterministic operational metadata kept strictly separate from finding IDs.
 */
export interface OperationalMetadata {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

/**
 * Authoritative JSON report contract produced by DP Crawler.
 */
export interface CrawlReport {
  readonly schemaVersion: string;
  readonly toolVersion: string;
  readonly adapter: AdapterInfo;
  readonly platform: Platform;
  readonly applicationBuildId?: string;
  readonly configHash: string;
  readonly profile: string;
  readonly targetId: string;
  readonly targetEntryPoint: string;
  readonly verificationLevel: TestEnvVerificationLevel;
  readonly safetyCoverage: SafetyCoverageReport;
  readonly completionStatus: CompletionStatus;
  readonly completionReason?: string;
  readonly coverage: CoverageReport;
  readonly elementOutcomes: readonly ElementOutcomeRecord[];
  readonly findings: readonly Finding[];
  readonly attributedErrors: readonly ErrorRecord[];
  readonly evidenceReferences: readonly string[];
  readonly limitations: readonly string[];
  readonly operational: OperationalMetadata;
}
