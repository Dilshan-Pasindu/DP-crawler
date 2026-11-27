/**
 * Screen-space or viewport-space bounding box for a UI element.
 */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Discrete confidence tier for element identity stability.
 */
export type IdentityConfidence = "HIGH" | "MEDIUM" | "LOW";

/**
 * Discovery layer that observed an element.
 */
export type DiscoverySource = "dom" | "uia" | "accessibility" | "ocr" | "visual";

/**
 * Session-scoped opaque reference to a live UI element.
 * Must never be persisted as a permanent cross-session identity.
 */
export interface NodeRef {
  readonly key: string;
  readonly driverRef: string;
}

/**
 * Platform-neutral UI element contract shared between adapters and the brain.
 * Intentionally excludes unrestricted driver-specific property bags.
 */
export interface UniversalNode {
  readonly key: string;
  readonly role: string;
  readonly name: string;
  readonly context: string;

  readonly testId?: string;
  readonly elementId?: string;
  readonly title?: string;
  readonly tooltip?: string;
  readonly destination?: string;
  readonly value?: string;
  readonly ordinal?: number;

  readonly bounds?: Bounds;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly interactive: boolean;

  readonly supportedActions: readonly string[];
  readonly identityConfidence: IdentityConfidence;
  readonly discoverySources: readonly DiscoverySource[];

  readonly children: readonly UniversalNode[];
  readonly ref: NodeRef;
}
