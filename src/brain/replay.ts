import type {
  AdapterSession,
  InteractionExecutionResult,
  UIAction,
  UniversalNode,
} from "../model/index.js";
import { normalizeName } from "./identity.js";

export interface RetryExecutionResult {
  readonly attempts: number;
  readonly execution: InteractionExecutionResult;
  readonly resolvedNode: UniversalNode | null;
}

function isSameLogicalControl(original: UniversalNode, candidate: UniversalNode): boolean {
  if (normalizeName(original.role) !== normalizeName(candidate.role)) {
    return false;
  }
  if (normalizeName(original.name) !== normalizeName(candidate.name)) {
    return false;
  }
  if (normalizeName(original.context) !== normalizeName(candidate.context)) {
    return false;
  }
  if (original.testId !== undefined && candidate.testId !== original.testId) {
    return false;
  }
  if (original.elementId !== undefined && candidate.elementId !== original.elementId) {
    return false;
  }
  if (candidate.identityConfidence === "LOW") {
    return false;
  }
  if (candidate.enabled !== original.enabled) {
    return false;
  }
  return true;
}

/**
 * Executes an action with bounded re-resolution when an element becomes unstable/detached.
 * Never retries if action dispatch may already have occurred, and never uses force interaction.
 */
export async function executeWithRetry(params: {
  readonly session: AdapterSession;
  readonly node: UniversalNode;
  readonly action: UIAction;
  readonly maxRetries: number;
}): Promise<RetryExecutionResult> {
  const { session, node, action, maxRetries } = params;
  let currentNode: UniversalNode | null = node;
  let attempts = 0;

  while (attempts <= maxRetries) {
    attempts += 1;
    if (currentNode === null) {
      return {
        attempts,
        resolvedNode: null,
        execution: {
          attempted: false,
          succeeded: false,
          obscured: false,
          unstable: true,
          unsupportedReason: "unstable-control",
          signals: [],
        },
      };
    }

    const execution = await session.executeAction(currentNode, action);
    if (execution.dispatchMayHaveHappened === true) {
      // Never blindly re-dispatch an action that may already have executed
      return { attempts, execution, resolvedNode: currentNode };
    }
    if (!execution.unstable || attempts > maxRetries) {
      return { attempts, execution, resolvedNode: currentNode };
    }

    const reResolved = await session.resolveNode(currentNode);
    if (reResolved === null || !isSameLogicalControl(currentNode, reResolved)) {
      return {
        attempts,
        resolvedNode: null,
        execution: {
          attempted: false,
          succeeded: false,
          obscured: false,
          unstable: true,
          unsupportedReason: "unstable-control",
          signals: execution.signals,
        },
      };
    }
    currentNode = reResolved;
  }

  return {
    attempts,
    resolvedNode: currentNode,
    execution: {
      attempted: false,
      succeeded: false,
      obscured: false,
      unstable: true,
      unsupportedReason: "unstable-control",
      signals: [],
    },
  };
}

/**
 * Restores session state using adapter-native mechanisms, never by clicking destructive UI controls.
 */
export async function safeRestoreState(
  session: AdapterSession,
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  if (!session.adapterInfo.capabilities.stateRestore) {
    return { ok: false, reason: "Adapter does not declare stateRestore capability" };
  }
  return session.restoreState();
}
