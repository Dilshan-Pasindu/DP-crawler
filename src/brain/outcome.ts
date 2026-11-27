import type { InteractionObservation, Outcome } from "../model/index.js";

/**
 * Classifies a single interaction observation into the canonical Outcome taxonomy.
 * Instability without attributable errors becomes NOT_TESTED rather than FAIL.
 */
export function classifyOutcome(
  observation: InteractionObservation,
  safetyAllowed: boolean,
): { readonly outcome: Outcome; readonly reason?: string } {
  if (!safetyAllowed) {
    return { outcome: "BLOCKED", ...(observation.reason !== undefined ? { reason: observation.reason } : {}) };
  }

  if (observation.obscured === true) {
    return { outcome: "OBSCURED", reason: observation.reason ?? "Target obstructed by another element" };
  }

  if (observation.attributedErrors.length > 0) {
    return {
      outcome: "FAIL",
      reason: observation.attributedErrors.map((e) => e.message).join("; "),
    };
  }

  if (observation.unstable === true) {
    return { outcome: "NOT_TESTED", reason: observation.reason ?? "unstable-control" };
  }

  if (!observation.interactionAttempted || !observation.interactionSucceeded) {
    return {
      outcome: "NOT_TESTED",
      reason: observation.reason ?? "Interaction could not be completed",
    };
  }

  if (!observation.changeDetected && !observation.changeCorrelated) {
    return { outcome: "DEAD", reason: "No meaningful reaction detected after interaction" };
  }

  return { outcome: "PASS" };
}

/**
 * Merges initial and confirmation observations, reporting FLAKY when outcomes differ materially.
 */
export function mergeAttemptOutcomes(first: Outcome, second: Outcome): Outcome {
  if (first === second) {
    return first;
  }
  return "FLAKY";
}
