import {
  describeAction,
  RunBlockedError,
  type AdapterSession,
  type CompletionStatus,
  type CrawlReport,
  type ElementOutcomeRecord,
  type ErrorRecord,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
  type InteractionObservation,
  type Outcome,
  type PlatformAdapter,
  type TargetDescriptor,
  type UIAction,
  type UniversalNode,
} from "../model/index.js";
import { buildFindingId, compareWithBaseline, type BaselineFile } from "./baseline.js";
import { correlateSignals } from "./correlation.js";
import { CoverageTracker } from "./coverage.js";
import { fingerprintState } from "./discovery.js";
import { ExplorationQueue } from "./exploration-queue.js";
import { flattenNodes } from "./identity.js";
import { classifyOutcome, mergeAttemptOutcomes } from "./outcome.js";
import { redactCrawlReport, redactErrorRecord } from "./redact.js";
import { executeWithRetry, safeRestoreState } from "./replay.js";
import { evaluateSafety, evaluateSafetyCoverage } from "./safety.js";

export const REPORT_SCHEMA_VERSION = "1.0.0";
export const TOOL_VERSION = "0.1.0";

export interface CrawlLimits {
  readonly maxDepth: number;
  readonly maxInteractions: number;
  readonly maxRunMinutes: number;
  readonly maxElementRetries: number;
  readonly maxRediscoveryPerState: number;
}

export interface CrawlClock {
  nowMs(): number;
  isoNow(): string;
  generateRunId(): string;
}

export const SYSTEM_CLOCK: CrawlClock = {
  nowMs: () => Date.now(),
  isoNow: () => new Date().toISOString(),
  generateRunId: () => `run_${Date.now().toString(36)}`,
};

export interface CrawlOptions {
  readonly adapter: PlatformAdapter;
  readonly target: TargetDescriptor;
  readonly profile: string;
  readonly configHash: string;
  readonly limits: CrawlLimits;
  readonly confirmationMode: "off" | "failures";
  readonly baseline?: BaselineFile;
  readonly activeProcessIdentity?: string;
  readonly clock?: CrawlClock;
}

function selectPrimaryAction(node: UniversalNode): UIAction {
  if (node.supportedActions.includes("invoke")) return { type: "invoke" };
  if (node.supportedActions.includes("expand")) return { type: "expand" };
  if (node.supportedActions.includes("toggle")) return { type: "toggle" };
  if (node.supportedActions.includes("focus")) return { type: "focus" };
  if (node.supportedActions.includes("scroll")) return { type: "scroll", direction: "down" };
  return { type: "invoke" };
}

function emptyObservation(reason?: string): InteractionObservation {
  return {
    interactionAttempted: false,
    interactionSucceeded: false,
    interactionDetected: false,
    changeDetected: false,
    changeCorrelated: false,
    expectedBehaviourVerified: false,
    attributedErrors: [],
    attributionConfidence: "LOW",
    signals: [],
    ...(reason !== undefined ? { reason } : {}),
  };
}

function mapOutcomeToFindingMeta(
  outcome: Outcome,
): { readonly category: FindingCategory; readonly severity: FindingSeverity } | null {
  switch (outcome) {
    case "FAIL":
      return { category: "application-error", severity: "HIGH" };
    case "FLAKY":
      return { category: "flaky-control", severity: "MEDIUM" };
    case "OBSCURED":
      return { category: "obscured-control", severity: "MEDIUM" };
    case "DEAD":
      return { category: "dead-control", severity: "LOW" };
    case "RESTORE_FAILED":
      return { category: "restore-failure", severity: "MEDIUM" };
    case "PASS":
    case "BLOCKED":
    case "NOT_TESTED":
      return null;
  }
}

function buildFindingFromOutcome(params: {
  readonly targetId: string;
  readonly node: UniversalNode;
  readonly action: UIAction;
  readonly path: readonly string[];
  readonly outcome: Outcome;
  readonly reason: string | undefined;
  readonly observation: InteractionObservation;
  readonly confirmed: boolean;
  readonly evidenceRef: string | undefined;
  readonly limitations: readonly string[];
}): Finding | null {
  const meta = mapOutcomeToFindingMeta(params.outcome);
  if (meta === null) {
    return null;
  }

  const firstError = params.observation.attributedErrors[0];
  const hasCrash = params.observation.signals.some((s) => s.kind === "process-crash");
  const category: FindingCategory = hasCrash ? "process-crash" : meta.category;
  const severity: FindingSeverity = hasCrash ? "CRITICAL" : meta.severity;
  const errorClassification = firstError?.category ?? params.outcome;
  const errorSummary =
    firstError?.message ?? params.reason ?? `Element interaction classified as ${params.outcome}`;

  const signature = {
    category,
    elementKey: params.node.key,
    targetId: params.targetId,
    pageContext: params.node.context,
    errorClassification,
    normalizedErrorMessage: errorSummary,
    interactionContext: describeAction(params.action),
  };

  return {
    id: buildFindingId(signature),
    category,
    severity,
    status: params.node.identityConfidence === "LOW" ? "REVIEW_REQUIRED" : "NEW",
    targetId: params.targetId,
    elementKey: params.node.key,
    elementName: params.node.name,
    elementRole: params.node.role,
    identityConfidence: params.node.identityConfidence,
    outcome: params.outcome,
    reproductionPath: [...params.path, `${params.node.role}:${params.node.name}`],
    errorSummary,
    attributionConfidence: params.observation.attributionConfidence,
    confirmed: params.confirmed,
    ...(params.evidenceRef !== undefined ? { evidenceRef: params.evidenceRef } : {}),
    limitations: [...params.limitations],
    signature,
  };
}

async function confirmInFreshSession(params: {
  readonly adapter: PlatformAdapter;
  readonly target: TargetDescriptor;
  readonly node: UniversalNode;
  readonly action: UIAction;
  readonly maxRetries: number;
  readonly activeProcessIdentity?: string;
}): Promise<Outcome | null> {
  let freshSession: AdapterSession | null = null;
  try {
    freshSession = await params.adapter.openSession(params.target);
    await freshSession.discover();
    const resolved = await freshSession.resolveNode(params.node);
    if (resolved === null) {
      return "NOT_TESTED";
    }
    const safety = evaluateSafety({
      target: params.target,
      node: resolved,
      action: params.action,
      capabilities: freshSession.adapterInfo.capabilities,
      ...(params.activeProcessIdentity !== undefined
        ? { activeProcessIdentity: params.activeProcessIdentity }
        : {}),
    });
    if (!safety.allowed) {
      return "BLOCKED";
    }
    const retryRes = await executeWithRetry({
      session: freshSession,
      node: resolved,
      action: params.action,
      maxRetries: params.maxRetries,
    });
    const observation = correlateSignals(resolved.key, retryRes.execution);
    return classifyOutcome(observation, true).outcome;
  } finally {
    if (freshSession !== null) {
      await freshSession.dispose();
    }
  }
}

/**
 * Executes a deterministic, safety-gated UI crawl using an injected PlatformAdapter.
 * Contains zero platform-specific or AI imports.
 */
export async function runCrawl(options: CrawlOptions): Promise<CrawlReport> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const startedMs = clock.nowMs();
  const startedAt = clock.isoNow();
  const runId = clock.generateRunId();
  const maxDurationMs = options.limits.maxRunMinutes * 60_000;

  let session: AdapterSession | null = null;
  const coverage = new CoverageTracker();
  const outcomes: ElementOutcomeRecord[] = [];
  const findings: Finding[] = [];
  const allErrors: ErrorRecord[] = [];
  const evidenceRefs = new Set<string>();
  const limitations: string[] = [];
  const testedOrFailedKeys = new Set<string>();

  let completionStatus: CompletionStatus = "COMPLETED";
  let completionReason: string | undefined;
  let safetyCoverage = evaluateSafetyCoverage([]);
  let adapterInfo = options.adapter.info;

  try {
    try {
      session = await options.adapter.openSession(options.target);
    } catch (err) {
      if (err instanceof RunBlockedError) {
        completionStatus = "RUN_BLOCKED";
        completionReason = err.message;
        const finishedMs = clock.nowMs();
        const finishedAt = clock.isoNow();
        return redactCrawlReport({
          schemaVersion: REPORT_SCHEMA_VERSION,
          toolVersion: TOOL_VERSION,
          adapter: adapterInfo,
          platform: options.target.platform,
          ...(options.target.buildId !== undefined ? { applicationBuildId: options.target.buildId } : {}),
          configHash: options.configHash,
          profile: options.profile,
          targetId: options.target.id,
          targetEntryPoint: options.target.entryPoint,
          verificationLevel: options.target.safety.verificationLevel,
          safetyCoverage,
          completionStatus,
          completionReason,
          coverage: coverage.buildReport(),
          elementOutcomes: outcomes,
          findings,
          attributedErrors: allErrors,
          evidenceReferences: [],
          limitations,
          operational: {
            runId,
            startedAt,
            finishedAt,
            durationMs: Math.max(0, finishedMs - startedMs),
          },
        });
      }
      throw err;
    }

    adapterInfo = session.adapterInfo;
    const activeSession = session;
    const protections = await activeSession.getSafetyCoverage();
    safetyCoverage = evaluateSafetyCoverage(protections);
    if (safetyCoverage.unavailableProtections.length > 0) {
      limitations.push(
        `Unavailable safety protections: ${safetyCoverage.unavailableProtections.join(", ")}`,
      );
    }

    if (!safetyCoverage.fullCoverage) {
      completionStatus = "RUN_BLOCKED";
      completionReason = `Missing required safety protections: ${safetyCoverage.missingRequiredProtections.join(", ")}`;
    } else if (!activeSession.adapterInfo.capabilities.discovery) {
      completionStatus = "RUN_BLOCKED";
      completionReason = `Adapter "${activeSession.adapterInfo.kind}" does not support UI discovery`;
    } else {
      const queue = new ExplorationQueue({
        maxDepth: options.limits.maxDepth,
        maxRediscoveryPerState: options.limits.maxRediscoveryPerState,
      });

      const enqueueSnapshot = (
        snapshotNodes: readonly UniversalNode[],
        location: string,
        depth: number,
        path: readonly string[],
        isRediscovery: boolean,
      ): boolean => {
        const flat = flattenNodes(snapshotNodes);
        const fingerprint = fingerprintState(location, flat);
        const withinRediscoveryLimit = queue.recordStateDiscovery(fingerprint);
        coverage.recordDiscovered(
          flat.map((n) => n.key),
          depth,
          isRediscovery,
        );
        if (!withinRediscoveryLimit) {
          return false;
        }
        let enqueuedAny = false;
        for (const node of flat) {
          if (!node.interactive) {
            continue;
          }
          if (
            queue.enqueue({
              node,
              action: selectPrimaryAction(node),
              depth,
              path,
              stateFingerprint: fingerprint,
            })
          ) {
            enqueuedAny = true;
          }
        }
        return enqueuedAny;
      };

      const initialSnapshot = await activeSession.discover();
      if (initialSnapshot.scrollLimitReached === true) {
        coverage.markScrollLimitReached();
        limitations.push("Exploration incomplete: scroll limit reached during discovery");
      }
      enqueueSnapshot(initialSnapshot.nodes, initialSnapshot.location, 0, [initialSnapshot.location], false);

      let interactionsUsed = 0;

      while (queue.size() > 0) {
        if (interactionsUsed >= options.limits.maxInteractions) {
          completionStatus = "LIMIT_REACHED";
          completionReason = `Reached maxInteractions limit (${options.limits.maxInteractions})`;
          break;
        }
        if (clock.nowMs() - startedMs >= maxDurationMs) {
          completionStatus = "LIMIT_REACHED";
          completionReason = `Reached maxRunMinutes limit (${options.limits.maxRunMinutes})`;
          break;
        }

        const item = queue.dequeue();
        if (item === undefined) break;

        const safety = evaluateSafety({
          target: options.target,
          node: item.node,
          action: item.action,
          capabilities: activeSession.adapterInfo.capabilities,
          ...(options.activeProcessIdentity !== undefined
            ? { activeProcessIdentity: options.activeProcessIdentity }
            : {}),
        });

        if (!safety.allowed) {
          const obs = emptyObservation(safety.reason);
          const rec: ElementOutcomeRecord = {
            elementKey: item.node.key,
            name: item.node.name,
            role: item.node.role,
            context: item.node.context,
            identityConfidence: item.node.identityConfidence,
            action: item.action,
            outcome: "BLOCKED",
            reason: safety.reason,
            observation: obs,
          };
          outcomes.push(rec);
          coverage.recordOutcome(rec);
          continue;
        }

        interactionsUsed += 1;
        const retryResult = await executeWithRetry({
          session: activeSession,
          node: item.node,
          action: item.action,
          maxRetries: options.limits.maxElementRetries,
        });

        const observation = correlateSignals(item.node.key, retryResult.execution);
        for (const err of observation.attributedErrors) {
          allErrors.push(redactErrorRecord(err));
        }

        let classified = classifyOutcome(observation, true);
        let evidenceRef = retryResult.execution.evidenceRef;

        if (
          (classified.outcome === "FAIL" || classified.outcome === "OBSCURED") &&
          evidenceRef === undefined &&
          activeSession.adapterInfo.capabilities.screenshots
        ) {
          const captured = await activeSession.captureScreenshot(item.node.key);
          if (captured !== null) {
            evidenceRef = captured;
          }
        }
        if (evidenceRef !== undefined) {
          evidenceRefs.add(evidenceRef);
        }

        let confirmed = false;
        if (
          options.confirmationMode === "failures" &&
          (classified.outcome === "FAIL" || classified.outcome === "DEAD")
        ) {
          const confirmOutcome = await confirmInFreshSession({
            adapter: options.adapter,
            target: options.target,
            node: item.node,
            action: item.action,
            maxRetries: options.limits.maxElementRetries,
            ...(options.activeProcessIdentity !== undefined
              ? { activeProcessIdentity: options.activeProcessIdentity }
              : {}),
          });
          if (confirmOutcome !== null) {
            confirmed = true;
            const merged = mergeAttemptOutcomes(classified.outcome, confirmOutcome);
            if (merged !== classified.outcome) {
              classified = {
                outcome: merged,
                reason: `Initial outcome ${classified.outcome}, confirmation returned ${confirmOutcome}`,
              };
            }
          }
        }

        const rec: ElementOutcomeRecord = {
          elementKey: item.node.key,
          name: item.node.name,
          role: item.node.role,
          context: item.node.context,
          identityConfidence: item.node.identityConfidence,
          action: item.action,
          outcome: classified.outcome,
          ...(classified.reason !== undefined ? { reason: classified.reason } : {}),
          observation,
          ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        };
        outcomes.push(rec);
        coverage.recordOutcome(rec);
        if (classified.outcome === "PASS" || classified.outcome === "FAIL") {
          testedOrFailedKeys.add(item.node.key);
        }

        const maybeFinding = buildFindingFromOutcome({
          targetId: options.target.id,
          node: item.node,
          action: item.action,
          path: item.path,
          outcome: classified.outcome,
          reason: classified.reason,
          observation,
          confirmed,
          evidenceRef,
          limitations,
        });
        if (maybeFinding !== null) {
          findings.push(maybeFinding);
        }

        // Rediscover if meaningful state/navigation reaction occurred
        let revealedNewQueueItems = false;
        if (observation.changeDetected && item.depth < options.limits.maxDepth) {
          const nextSnapshot = await activeSession.discover();
          if (nextSnapshot.scrollLimitReached === true) {
            coverage.markScrollLimitReached();
            limitations.push("Exploration incomplete: scroll limit reached during rediscovery");
          }
          revealedNewQueueItems = enqueueSnapshot(
            nextSnapshot.nodes,
            nextSnapshot.location,
            item.depth + 1,
            [...item.path, `${item.node.role}:${item.node.name}`],
            true,
          );
        }

        // Restore state between interactions only when not immediately exploring newly revealed child items
        if (
          observation.changeDetected &&
          !revealedNewQueueItems &&
          activeSession.adapterInfo.capabilities.stateRestore
        ) {
          const restored = await safeRestoreState(activeSession);
          if (!restored.ok) {
            const restoreObs = emptyObservation(restored.reason ?? "State restore failed");
            const restoreRec: ElementOutcomeRecord = {
              elementKey: item.node.key,
              name: item.node.name,
              role: item.node.role,
              context: item.node.context,
              identityConfidence: item.node.identityConfidence,
              action: item.action,
              outcome: "RESTORE_FAILED",
              reason: restored.reason ?? "State restore failed",
              observation: restoreObs,
            };
            outcomes.push(restoreRec);
            coverage.recordOutcome(restoreRec);
            const restoreFinding = buildFindingFromOutcome({
              targetId: options.target.id,
              node: item.node,
              action: item.action,
              path: item.path,
              outcome: "RESTORE_FAILED",
              reason: restoreRec.reason,
              observation: restoreObs,
              confirmed: false,
              evidenceRef: undefined,
              limitations,
            });
            if (restoreFinding !== null) {
              findings.push(restoreFinding);
            }
          }
        }
      }

      // Never silently discard remaining queued elements when a limit stops exploration
      for (const remaining of queue.drainRemaining()) {
        const reason = completionReason ?? "Exploration limit reached";
        const notTestedRec: ElementOutcomeRecord = {
          elementKey: remaining.node.key,
          name: remaining.node.name,
          role: remaining.node.role,
          context: remaining.node.context,
          identityConfidence: remaining.node.identityConfidence,
          action: remaining.action,
          outcome: "NOT_TESTED",
          reason,
          observation: emptyObservation(reason),
        };
        outcomes.push(notTestedRec);
        coverage.recordOutcome(notTestedRec);
      }
    }

    const finishedMs = clock.nowMs();
    const finishedAt = clock.isoNow();
    const baselineComparison = compareWithBaseline({
      findings,
      baseline: options.baseline,
      completionStatus,
      testedOrFailedElementKeys: testedOrFailedKeys,
    });

    const report: CrawlReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      toolVersion: TOOL_VERSION,
      adapter: adapterInfo,
      platform: options.target.platform,
      ...(options.target.buildId !== undefined ? { applicationBuildId: options.target.buildId } : {}),
      configHash: options.configHash,
      profile: options.profile,
      targetId: options.target.id,
      targetEntryPoint: options.target.entryPoint,
      verificationLevel: options.target.safety.verificationLevel,
      safetyCoverage,
      completionStatus,
      ...(completionReason !== undefined ? { completionReason } : {}),
      coverage: coverage.buildReport(),
      elementOutcomes: outcomes,
      findings: baselineComparison.findings,
      attributedErrors: allErrors,
      evidenceReferences: [...evidenceRefs],
      limitations: [...new Set(limitations)],
      operational: {
        runId,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedMs - startedMs),
      },
    };

    return redactCrawlReport(report);
  } finally {
    if (session !== null) {
      await session.dispose();
    }
  }
}
