import {
  describeAction,
  supportsAction,
  type AdapterCapabilities,
  type SafetyCoverageReport,
  type SafetyProtection,
  type TargetDescriptor,
  type UIAction,
  type UniversalNode,
} from "../model/index.js";

/**
 * Mandatory default-deny risky action words and phrases (Section 9.2).
 */
export const DEFAULT_RISKY_TERMS: readonly string[] = [
  "delete",
  "remove",
  "destroy",
  "erase",
  "reset",
  "clear",
  "deactivate",
  "close account",
  "pay",
  "checkout",
  "buy",
  "purchase",
  "place order",
  "confirm order",
  "cancel order",
  "cancel booking",
  "cancel subscription",
  "unsubscribe",
  "send",
  "submit",
  "save",
  "publish",
  "deploy",
  "transfer",
  "approve",
  "revoke",
  "disable",
  "terminate",
  "refund",
  "withdraw",
  "wipe",
  "purge",
  "invite",
  "archive",
  "logout",
  "sign out",
];

/**
 * Normalizes text for risky action matching per Section 9.2:
 * splits camelCase, hyphens, underscores, slashes, punctuation, lowercases, and collapses spaces.
 */
export function normalizeForRiskMatch(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_/.,:;!?()[\]{}"'`~\\|@#$%^&*+=<>]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Matches a normalized term or phrase on whole-word boundaries.
 */
export function matchWholeWordOrPhrase(normalizedHaystack: string, term: string): boolean {
  const normalizedTerm = normalizeForRiskMatch(term);
  if (normalizedTerm.length === 0 || normalizedHaystack.length === 0) {
    return false;
  }
  const paddedHaystack = ` ${normalizedHaystack} `;
  return paddedHaystack.includes(` ${normalizedTerm} `);
}

function findMatchedTerms(fields: readonly (string | undefined)[], terms: readonly string[]): string[] {
  const normalizedFields = fields
    .filter((f): f is string => f !== undefined && f.trim().length > 0)
    .map(normalizeForRiskMatch);

  const matched: string[] = [];
  for (const term of terms) {
    if (normalizedFields.some((haystack) => matchWholeWordOrPhrase(haystack, term))) {
      matched.push(term);
    }
  }
  return matched;
}

export interface RiskClassification {
  readonly risky: boolean;
  readonly matchedTerms: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Classifies whether a node + action represents a potentially risky or mutating operation,
 * considering label, title, tooltip, identifiers, destination, context, and action type.
 */
export function classifyRiskyAction(
  node: UniversalNode,
  action: UIAction,
  extraTerms: readonly string[] = [],
): RiskClassification {
  const fields: readonly (string | undefined)[] = [
    node.name,
    node.title,
    node.tooltip,
    node.elementId,
    node.testId,
    node.destination,
    node.context,
    describeAction(action),
  ];

  const terms = [...DEFAULT_RISKY_TERMS, ...extraTerms];
  const matchedTerms = findMatchedTerms(fields, terms);
  const reasons: string[] = [];

  if (matchedTerms.length > 0) {
    reasons.push(`Matched risky keywords: ${matchedTerms.join(", ")}`);
  }

  if (action.type === "setValue" || action.type === "select" || action.type === "toggle") {
    reasons.push(`Action type "${action.type}" mutates UI input state`);
  }

  if (node.destination !== undefined && node.destination.trim().length > 0) {
    const destLower = node.destination.toLowerCase();
    if (destLower.includes("checkout") || destLower.includes("payment") || destLower.includes("delete")) {
      reasons.push("Destination URL/route indicates sensitive or mutating operation");
    }
  }

  return {
    risky: matchedTerms.length > 0 || reasons.length > 0,
    matchedTerms,
    reasons,
  };
}

export interface SafetyEvaluationResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly ruleLayer:
    | "global-deny"
    | "target-restriction"
    | "profile-deny"
    | "mandatory-gate"
    | "default-safety"
    | "exception"
    | "allowed";
}

function isOriginAllowed(destination: string, allowedOrigins: readonly string[]): boolean {
  if (destination.trim().length === 0 || destination.startsWith("/") || destination.startsWith("#")) {
    return true;
  }
  try {
    const url = new URL(destination);
    return allowedOrigins.includes(url.origin);
  } catch {
    // Relative or non-URL native destination without cross-origin scheme
    return true;
  }
}

/**
 * Evaluates interaction safety using Section 9.1 checks and Section 9.3 precedence:
 * 1. Global deny
 * 2. Target restrictions
 * 3. Profile deny
 * 4. Mandatory precondition gates (visibility, enabled, capability, identity confidence)
 * 5. Default safety rules (with exact exception check)
 */
export function evaluateSafety(params: {
  readonly target: TargetDescriptor;
  readonly node: UniversalNode;
  readonly action: UIAction;
  readonly capabilities: AdapterCapabilities;
  readonly activeProcessIdentity?: string;
}): SafetyEvaluationResult {
  const { target, node, action, capabilities, activeProcessIdentity } = params;
  const { safety } = target;
  const candidateFields = [
    node.name,
    node.title,
    node.tooltip,
    node.elementId,
    node.testId,
    node.destination,
    node.context,
  ];

  // 1. Global deny
  const globalMatches = findMatchedTerms(candidateFields, safety.globalDenyTerms);
  if (globalMatches.length > 0) {
    return {
      allowed: false,
      ruleLayer: "global-deny",
      reason: `Blocked by global deny policy (${globalMatches.join(", ")})`,
    };
  }

  // 2. Target restrictions
  if (target.isRemote && !safety.confirmRemote) {
    return {
      allowed: false,
      ruleLayer: "target-restriction",
      reason: "Remote target interaction blocked because confirmRemote is false",
    };
  }

  if (
    target.processIdentity !== undefined &&
    activeProcessIdentity !== undefined &&
    target.processIdentity !== activeProcessIdentity
  ) {
    return {
      allowed: false,
      ruleLayer: "target-restriction",
      reason: `Process boundary mismatch: expected ${target.processIdentity}, got ${activeProcessIdentity}`,
    };
  }

  if (
    node.destination !== undefined &&
    target.allowedOrigins.length > 0 &&
    !isOriginAllowed(node.destination, target.allowedOrigins)
  ) {
    return {
      allowed: false,
      ruleLayer: "target-restriction",
      reason: `Destination outside allowedOrigins: ${node.destination}`,
    };
  }

  const targetMatches = findMatchedTerms(candidateFields, safety.targetDenyTerms);
  if (targetMatches.length > 0) {
    return {
      allowed: false,
      ruleLayer: "target-restriction",
      reason: `Blocked by target deny policy (${targetMatches.join(", ")})`,
    };
  }

  // 3. Profile deny
  const profileMatches = findMatchedTerms(candidateFields, safety.profileDenyTerms);
  if (profileMatches.length > 0) {
    return {
      allowed: false,
      ruleLayer: "profile-deny",
      reason: `Blocked by profile deny policy (${profileMatches.join(", ")})`,
    };
  }

  // 4. Mandatory precondition gates
  if (!node.visible || !node.enabled || !node.interactive) {
    return {
      allowed: false,
      ruleLayer: "mandatory-gate",
      reason: "Element is not visible, enabled, and interactive",
    };
  }

  if (!supportsAction(capabilities, action.type)) {
    return {
      allowed: false,
      ruleLayer: "mandatory-gate",
      reason: `Adapter does not support action capability "${action.type}"`,
    };
  }

  if (!node.supportedActions.includes(action.type)) {
    return {
      allowed: false,
      ruleLayer: "mandatory-gate",
      reason: `Element does not advertise supported action "${action.type}"`,
    };
  }

  if (node.identityConfidence === "LOW") {
    return {
      allowed: false,
      ruleLayer: "mandatory-gate",
      reason: "Blocked interaction with LOW identity confidence element",
    };
  }

  // 5. Default safety rules + exact approved exception
  const risk = classifyRiskyAction(node, action);
  const matchingException = safety.exceptions.find(
    (ex) => ex.locatorKey === node.key && ex.action === action.type && ex.reason.trim().length > 0,
  );

  if (risk.risky) {
    const envVerified =
      safety.verificationLevel === "HIGH" || safety.verificationLevel === "MEDIUM";

    // Mutations require verified test environment + explicit opt-in or exact exception
    if (matchingException !== undefined) {
      if (risk.matchedTerms.length === 0 || (envVerified && safety.allowMutationsOnVerifiedEnv)) {
        return {
          allowed: true,
          ruleLayer: "exception",
          reason: `Approved exception: ${matchingException.reason}`,
        };
      }
      return {
        allowed: false,
        ruleLayer: "default-safety",
        reason: "Approved exception blocked because test environment verification is insufficient for risky action",
      };
    }

    if (
      risk.matchedTerms.length === 0 &&
      envVerified &&
      safety.allowMutationsOnVerifiedEnv
    ) {
      return {
        allowed: true,
        ruleLayer: "allowed",
        reason: "Non-destructive input mutation allowed on verified test environment",
      };
    }

    return {
      allowed: false,
      ruleLayer: "default-safety",
      reason: risk.reasons.join("; "),
    };
  }

  return {
    allowed: true,
    ruleLayer: "allowed",
    reason: "Passed all safety checks",
  };
}

/**
 * Summarizes active, unavailable, and missing required protections.
 */
export function evaluateSafetyCoverage(protections: readonly SafetyProtection[]): SafetyCoverageReport {
  const activeProtections: string[] = [];
  const unavailableProtections: string[] = [];
  const missingRequiredProtections: string[] = [];

  for (const protection of protections) {
    if (protection.active) {
      activeProtections.push(protection.name);
    } else {
      unavailableProtections.push(
        protection.reason !== undefined ? `${protection.name} (${protection.reason})` : protection.name,
      );
      if (protection.required) {
        missingRequiredProtections.push(protection.name);
      }
    }
  }

  return {
    activeProtections,
    unavailableProtections,
    missingRequiredProtections,
    fullCoverage: missingRequiredProtections.length === 0,
  };
}
