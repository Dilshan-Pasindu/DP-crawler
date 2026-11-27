import type { UIAction } from "./actions.js";
import type { AdapterInfo } from "./capabilities.js";
import type { SignalEvent } from "./outcome.js";
import type { UniversalNode } from "./universal-node.js";

/**
 * Individual safety protection status reported by the active adapter and engine.
 */
export interface SafetyProtection {
  readonly name: string;
  readonly active: boolean;
  readonly required: boolean;
  readonly reason?: string;
}

/**
 * Explicit summary of active vs. unavailable protections.
 */
export interface SafetyCoverageReport {
  readonly activeProtections: readonly string[];
  readonly unavailableProtections: readonly string[];
  readonly missingRequiredProtections: readonly string[];
  readonly fullCoverage: boolean;
}

/**
 * Lightweight, platform-neutral snapshot of the current UI state.
 */
export interface StateSnapshot {
  readonly location: string;
  readonly stateHash: string;
  readonly nodes: readonly UniversalNode[];
  readonly scrollLimitReached?: boolean;
}

/**
 * Result returned by an adapter after attempting a single UIAction.
 */
export interface InteractionExecutionResult {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly obscured: boolean;
  readonly unstable: boolean;
  readonly unsupportedReason?: string;
  readonly signals: readonly SignalEvent[];
  readonly evidenceRef?: string;
}

/**
 * Controlled adapter session representing a single target inspection/crawl context.
 */
export interface AdapterSession {
  readonly sessionId: string;
  readonly adapterInfo: AdapterInfo;

  /**
   * Reports which safety protections are active or unavailable for this session.
   */
  getSafetyCoverage(): Promise<readonly SafetyProtection[]>;

  /**
   * Discovers the current UI tree without modifying application state.
   */
  discover(): Promise<StateSnapshot>;

  /**
   * Re-resolves a previously discovered node after state changes or detachment.
   */
  resolveNode(node: UniversalNode): Promise<UniversalNode | null>;

  /**
   * Executes an explicit UI action on a resolved node.
   */
  executeAction(node: UniversalNode, action: UIAction): Promise<InteractionExecutionResult>;

  /**
   * Captures a redacted/masked screenshot reference when supported.
   */
  captureScreenshot(label: string): Promise<string | null>;

  /**
   * Restores the application to its baseline entry state without clicking destructive UI controls.
   */
  restoreState(): Promise<{ readonly ok: boolean; readonly reason?: string }>;

  /**
   * Disposes all underlying browser/process resources cleanly.
   */
  dispose(): Promise<void>;
}
