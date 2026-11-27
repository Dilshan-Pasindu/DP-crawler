import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AdapterKind, Platform, TargetDescriptor } from "./model/index.js";

const PlatformSchema = z.enum(["web", "windows", "macos", "java-windows", "java-macos"]);
const AdapterKindSchema = z.enum([
  "playwright",
  "electron-cdp",
  "tauri-webview",
  "windows-uia",
  "macos-ax",
  "java-access-bridge",
  "mock",
]);

const ExceptionRuleSchema = z.object({
  locatorKey: z.string().min(1),
  action: z.enum(["invoke", "setValue", "toggle", "select", "expand", "collapse", "focus", "scroll"]),
  reason: z.string().min(3),
});

const TargetSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  platform: PlatformSchema,
  adapter: AdapterKindSchema.optional(),
  startUrl: z.string().url().optional(),
  entryPoint: z.string().min(1).optional(),
  allowedOrigins: z.array(z.string().min(1)).default([]),
  processIdentity: z.string().min(1).optional(),
  buildId: z.string().min(1).optional(),
  cdpEndpoint: z.string().url().optional(),
  startCommand: z.string().min(1).optional(),
  uiaBackend: z.enum(["uia3", "uia2"]).default("uia3"),
  helperCommand: z.string().min(1).optional(),
  helperArgs: z.array(z.string()).optional(),
  operationTimeoutMs: z.number().int().positive().max(60_000).optional(),
});

const LimitsSchema = z
  .object({
    maxDepth: z.number().int().min(0).max(20).default(3),
    maxInteractions: z.number().int().min(1).max(10_000).default(200),
    maxRunMinutes: z.number().positive().max(240).default(30),
    maxElementRetries: z.number().int().min(0).max(5).default(1),
    maxRediscoveryPerState: z.number().int().min(1).max(20).default(3),
  })
  .default({});

const SafetySchema = z
  .object({
    confirmRemote: z.boolean().default(false),
    testDataConfirmed: z.boolean().default(false),
    verificationLevel: z.enum(["HIGH", "MEDIUM", "LOW", "NONE"]).default("NONE"),
    allowMutationsOnVerifiedEnv: z.boolean().default(false),
    globalDenyTerms: z.array(z.string()).default([]),
    targetDenyTerms: z.array(z.string()).default([]),
    profileDenyTerms: z.array(z.string()).default([]),
    exceptions: z.array(ExceptionRuleSchema).default([]),
    allowHttpMutations: z
      .array(z.object({ method: z.string().min(1), endpoint: z.string().min(1), reason: z.string().min(1) }))
      .default([]),
    denyEndpoints: z
      .array(z.object({ endpoint: z.string().min(1), reason: z.string().min(1) }))
      .default([]),
    allowWebSocketConnections: z
      .array(z.object({ endpoint: z.string().min(1), reason: z.string().min(1) }))
      .default([]),
  })
  .default({});

const AuthSchema = z
  .object({
    mode: z.enum(["none", "replay", "api-token", "interactive"]).default("none"),
    storageStatePath: z.string().min(1).optional(),
    sessionStoragePath: z.string().min(1).optional(),
    tokenEnvVar: z.string().min(1).optional(),
    loginUrl: z.string().url().optional(),
    expectedAuthenticatedSelector: z.string().min(1).optional(),
  })
  .default({});

const EvidenceSchema = z
  .object({
    trace: z.enum(["off", "on-failure", "on"]).default("off"),
    screenshots: z.boolean().default(true),
    screenshotMasks: z.array(z.string()).default([]),
    outputDir: z.string().min(1).default("reports"),
  })
  .default({});

export const ProfileConfigSchema = z
  .object({
    target: TargetSchema,
    limits: LimitsSchema,
    safety: SafetySchema,
    auth: AuthSchema,
    evidence: EvidenceSchema,
    confirmation: z.enum(["off", "failures"]).default("failures"),
    baselinePath: z.string().min(1).optional(),
    ignoredElements: z.array(z.string()).default([]),
    ignoredErrors: z.array(z.string()).default([]),
  })
  .superRefine((profile, ctx) => {
    if (profile.target.startUrl === undefined && profile.target.entryPoint === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Target must specify either startUrl or entryPoint.",
      });
    }
  });

export const ConfigSchema = z.object({
  profiles: z.record(z.string().min(1), ProfileConfigSchema),
});

export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;
export type CrawlerConfig = z.infer<typeof ConfigSchema>;

function defaultAdapterForPlatform(platform: Platform): AdapterKind {
  switch (platform) {
    case "web":
      return "playwright";
    case "windows":
      return "windows-uia";
    case "macos":
      return "macos-ax";
    case "java-windows":
    case "java-macos":
      return "java-access-bridge";
  }
}

function isRemoteEntry(entryPoint: string): boolean {
  try {
    const url = new URL(entryPoint);
    return url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1";
  } catch {
    return false;
  }
}

/**
 * Parses and validates raw JSON configuration using Zod, throwing detailed startup errors.
 */
export function parseConfig(raw: unknown): CrawlerConfig {
  return ConfigSchema.parse(raw);
}

/**
 * Loads and validates a DP Crawler JSON configuration file from disk.
 */
export async function loadConfigFile(filePath: string): Promise<CrawlerConfig> {
  const content = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  return parseConfig(parsed);
}

/**
 * Selects a named profile from a validated configuration.
 */
export function getProfile(config: CrawlerConfig, profileName: string): ProfileConfig {
  const profile = config.profiles[profileName];
  if (profile === undefined) {
    throw new Error(`Profile "${profileName}" not found in configuration.`);
  }
  return profile;
}

/**
 * Converts a validated ProfileConfig into a brain-ready TargetDescriptor.
 */
export function profileToTargetDescriptor(profileName: string, profile: ProfileConfig): TargetDescriptor {
  const entryPoint = profile.target.startUrl ?? profile.target.entryPoint ?? "";
  return {
    id: profile.target.id ?? profileName,
    name: profile.target.name ?? profileName,
    platform: profile.target.platform,
    adapter: profile.target.adapter ?? defaultAdapterForPlatform(profile.target.platform),
    entryPoint,
    allowedOrigins: profile.target.allowedOrigins,
    ...(profile.target.processIdentity !== undefined
      ? { processIdentity: profile.target.processIdentity }
      : {}),
    ...(profile.target.buildId !== undefined ? { buildId: profile.target.buildId } : {}),
    isRemote: isRemoteEntry(entryPoint),
    auth: {
      mode: profile.auth.mode,
      ...(profile.auth.storageStatePath !== undefined ? { storageStatePath: profile.auth.storageStatePath } : {}),
      ...(profile.auth.sessionStoragePath !== undefined
        ? { sessionStoragePath: profile.auth.sessionStoragePath }
        : {}),
      ...(profile.auth.tokenEnvVar !== undefined ? { tokenEnvVar: profile.auth.tokenEnvVar } : {}),
      ...(profile.auth.loginUrl !== undefined ? { loginUrl: profile.auth.loginUrl } : {}),
      ...(profile.auth.expectedAuthenticatedSelector !== undefined
        ? { expectedAuthenticatedSelector: profile.auth.expectedAuthenticatedSelector }
        : {}),
    },
    evidence: {
      outputDir: profile.evidence.outputDir,
      screenshots: profile.evidence.screenshots,
      screenshotMasks: profile.evidence.screenshotMasks,
      trace: profile.evidence.trace,
    },
    ...(profile.target.platform === "windows"
      ? {
          windows: {
            uiaBackend: profile.target.uiaBackend,
            ...(profile.target.helperCommand !== undefined
              ? { helperCommand: profile.target.helperCommand }
              : {}),
            ...(profile.target.helperArgs !== undefined
              ? { helperArgs: profile.target.helperArgs }
              : {}),
            ...(profile.target.operationTimeoutMs !== undefined
              ? { operationTimeoutMs: profile.target.operationTimeoutMs }
              : {}),
            ...(profile.target.startCommand !== undefined
              ? { startCommand: profile.target.startCommand }
              : {}),
          },
        }
      : {}),
    safety: {
      confirmRemote: profile.safety.confirmRemote,
      testDataConfirmed: profile.safety.testDataConfirmed,
      verificationLevel: profile.safety.verificationLevel,
      allowMutationsOnVerifiedEnv: profile.safety.allowMutationsOnVerifiedEnv,
      globalDenyTerms: profile.safety.globalDenyTerms,
      targetDenyTerms: profile.safety.targetDenyTerms,
      profileDenyTerms: profile.safety.profileDenyTerms,
      exceptions: profile.safety.exceptions,
      network: {
        allowHttpMutations: profile.safety.allowHttpMutations,
        denyEndpoints: profile.safety.denyEndpoints,
        allowWebSocketConnections: profile.safety.allowWebSocketConnections,
      },
    },
  };
}

/**
 * Computes a deterministic SHA-256 hash for a validated profile configuration.
 */
export function hashConfig(profile: ProfileConfig): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 16);
}
