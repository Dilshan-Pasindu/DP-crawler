import type { UIActionType } from "./actions.js";

/**
 * Supported target runtime platforms.
 */
export type Platform =
  | "web"
  | "windows"
  | "macos"
  | "java-windows"
  | "java-macos";

/**
 * Adapter implementation identifiers.
 */
export type AdapterKind =
  | "playwright"
  | "electron-cdp"
  | "tauri-webview"
  | "windows-uia"
  | "macos-ax"
  | "java-access-bridge"
  | "mock";

/**
 * Evidence tier for whether the target backend is isolated for test traffic.
 * NONE or LOW must never be treated as proof that mutating operations are safe.
 */
export type TestEnvVerificationLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/**
 * Explicit narrow safety exception approved by a human operator.
 */
export interface SafetyExceptionRule {
  readonly locatorKey: string;
  readonly action: UIActionType;
  readonly reason: string;
}

/**
 * Network guard rules for web/CDP adapters.
 */
export interface NetworkSafetyConfig {
  readonly allowHttpMutations: readonly {
    readonly method: string;
    readonly endpoint: string;
    readonly reason: string;
  }[];
  readonly denyEndpoints: readonly {
    readonly endpoint: string;
    readonly reason: string;
  }[];
  readonly allowWebSocketConnections: readonly {
    readonly endpoint: string;
    readonly reason: string;
  }[];
}

/**
 * Layered safety configuration passed to the brain's safety evaluator.
 */
export interface TargetSafetyConfig {
  readonly confirmRemote: boolean;
  readonly testDataConfirmed: boolean;
  readonly verificationLevel: TestEnvVerificationLevel;
  readonly allowMutationsOnVerifiedEnv: boolean;
  readonly globalDenyTerms: readonly string[];
  readonly targetDenyTerms: readonly string[];
  readonly profileDenyTerms: readonly string[];
  readonly exceptions: readonly SafetyExceptionRule[];
  readonly network: NetworkSafetyConfig;
}

/**
 * Authentication configuration passed to an adapter session.
 * Never embeds raw credentials.
 */
export interface TargetAuthConfig {
  readonly mode: "none" | "replay" | "api-token" | "interactive";
  readonly storageStatePath?: string;
  readonly sessionStoragePath?: string;
  readonly tokenEnvVar?: string;
  readonly loginUrl?: string;
  readonly expectedAuthenticatedSelector?: string;
}

/**
 * Evidence and capture options for a target session.
 */
export interface TargetEvidenceConfig {
  readonly outputDir: string;
  readonly runId?: string;
  readonly screenshots: boolean;
  readonly screenshotMasks: readonly string[];
  readonly trace: "off" | "on-failure" | "on";
}

/**
 * Target application descriptor establishing platform, identity, and boundaries.
 */
export interface TargetDescriptor {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly adapter: AdapterKind;
  readonly entryPoint: string;
  readonly allowedOrigins: readonly string[];
  readonly processIdentity?: string;
  readonly buildId?: string;
  readonly executablePath?: string;
  readonly isRemote: boolean;
  readonly safety: TargetSafetyConfig;
  readonly auth?: TargetAuthConfig;
  readonly evidence?: TargetEvidenceConfig;
}
