import type { IdentityConfidence, UniversalNode } from "../model/index.js";

export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW";

/**
 * Separate confidence dimensions for an element.
 * Never collapsed into one misleading single score or probability.
 */
export interface ConfidenceProfile {
  readonly identityConfidence: IdentityConfidence;
  readonly visibilityConfidence: ConfidenceTier;
  readonly actionabilityConfidence: ConfidenceTier;
  readonly stateStabilityConfidence: ConfidenceTier;
  readonly evidenceQuality: ConfidenceTier;
}

/**
 * Evaluates independent confidence dimensions for a discovered UniversalNode.
 */
export function assessNodeConfidence(
  node: UniversalNode,
  options?: { readonly unstable?: boolean; readonly hasCorroboratingEvidence?: boolean },
): ConfidenceProfile {
  const hasStrongId =
    (node.testId !== undefined && node.testId.trim().length > 0) ||
    (node.elementId !== undefined && node.elementId.trim().length > 0);

  let identityConfidence: IdentityConfidence = node.identityConfidence;
  if (hasStrongId && node.discoverySources.some((s) => s === "dom" || s === "uia" || s === "accessibility")) {
    identityConfidence = "HIGH";
  }

  const hasBounds = node.bounds !== undefined && node.bounds.width > 0 && node.bounds.height > 0;
  const visibilityConfidence: ConfidenceTier =
    node.visible && hasBounds ? "HIGH" : node.visible ? "MEDIUM" : "LOW";

  const hasSemanticSource = node.discoverySources.some(
    (s) => s === "dom" || s === "uia" || s === "accessibility",
  );
  const actionabilityConfidence: ConfidenceTier =
    node.interactive && node.enabled && node.supportedActions.length > 0 && hasSemanticSource
      ? "HIGH"
      : node.interactive && node.enabled
        ? "MEDIUM"
        : "LOW";

  const stateStabilityConfidence: ConfidenceTier = options?.unstable ? "LOW" : hasStrongId ? "HIGH" : "MEDIUM";
  const evidenceQuality: ConfidenceTier = options?.hasCorroboratingEvidence ? "HIGH" : hasSemanticSource ? "MEDIUM" : "LOW";

  return {
    identityConfidence,
    visibilityConfidence,
    actionabilityConfidence,
    stateStabilityConfidence,
    evidenceQuality,
  };
}
