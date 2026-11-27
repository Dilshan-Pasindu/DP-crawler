import type {
  AdapterSession,
  InteractionExecutionResult,
  UIAction,
  UniversalNode,
} from "../model/index.js";

export interface RetryExecutionResult {
  readonly attempts: number;
  readonly execution: InteractionExecutionResult;
  readonly resolvedNode: UniversalNode | null;
}

/**
 * Executes an action with bounded re-resolution when an element becomes unstable/detached.
 * Never uses force interaction.
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
    if (!execution.unstable || attempts > maxRetries) {
      return { attempts, execution, resolvedNode: currentNode };
    }

    currentNode = await session.resolveNode(currentNode);
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
