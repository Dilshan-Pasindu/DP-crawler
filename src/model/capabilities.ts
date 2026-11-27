import type { UIActionType } from "./actions.js";
import type { AdapterSession } from "./session.js";
import type { AdapterKind, Platform, TargetDescriptor } from "./target.js";

/**
 * Explicit boolean capability matrix declared by every platform adapter.
 */
export interface AdapterCapabilities {
  readonly discovery: boolean;
  readonly invoke: boolean;
  readonly setValue: boolean;
  readonly toggle: boolean;
  readonly select: boolean;
  readonly expand: boolean;
  readonly collapse: boolean;
  readonly focus: boolean;
  readonly keyboard: boolean;
  readonly pointer: boolean;
  readonly scrolling: boolean;
  readonly screenshots: boolean;
  readonly accessibilityEvents: boolean;
  readonly networkObservation: boolean;
  readonly processMonitoring: boolean;
  readonly stateRestore: boolean;
}

/**
 * Self-identifying metadata exposed by each adapter.
 */
export interface AdapterInfo {
  readonly kind: AdapterKind;
  readonly platform: Platform;
  readonly version: string;
  readonly runtimeVersion?: string;
  readonly capabilities: AdapterCapabilities;
}

/**
 * Maps a requested UIActionType to the capability flag that must be true.
 */
export function requiredCapabilityForAction(actionType: UIActionType): keyof AdapterCapabilities {
  switch (actionType) {
    case "invoke":
      return "invoke";
    case "setValue":
      return "setValue";
    case "toggle":
      return "toggle";
    case "select":
      return "select";
    case "expand":
      return "expand";
    case "collapse":
      return "collapse";
    case "focus":
      return "focus";
    case "scroll":
      return "scrolling";
  }
}

/**
 * Checks whether an adapter supports the given UIActionType.
 */
export function supportsAction(capabilities: AdapterCapabilities, actionType: UIActionType): boolean {
  const key = requiredCapabilityForAction(actionType);
  return capabilities[key];
}

/**
 * Error thrown or returned when an adapter lacks a requested capability.
 * Unsupported operations must be reported explicitly, never silently simulated.
 */
export class UnsupportedOperationError extends Error {
  readonly operation: string;
  readonly adapterKind: AdapterKind;

  constructor(adapterKind: AdapterKind, operation: string) {
    super(`Adapter "${adapterKind}" does not support operation "${operation}".`);
    this.name = "UnsupportedOperationError";
    this.adapterKind = adapterKind;
    this.operation = operation;
  }
}

/**
 * Platform adapter contract consumed by the shared brain via AdapterRegistry.
 */
export interface PlatformAdapter {
  readonly info: AdapterInfo;

  /**
   * Checks runtime prerequisites (binaries, permissions, target reachability) without mutating state.
   */
  checkAvailability(target: TargetDescriptor): Promise<{
    readonly available: boolean;
    readonly details: readonly string[];
  }>;

  /**
   * Opens a controlled, safety-guarded session against the target application.
   */
  openSession(target: TargetDescriptor): Promise<AdapterSession>;
}
