import { z } from "zod";

export const HELPER_PROTOCOL_VERSION = "1.0.0";
export const MAX_RPC_FRAME_BYTES = 1024 * 1024; // 1 MiB bounded frame size

export const HelperCapabilitiesSchema = z.object({
  discovery: z.boolean(),
  invoke: z.boolean(),
  setValue: z.boolean(),
  toggle: z.boolean(),
  select: z.boolean(),
  expand: z.boolean(),
  collapse: z.boolean(),
  focus: z.boolean(),
  keyboard: z.boolean().default(false),
  pointer: z.boolean().default(false),
  scrolling: z.boolean().default(false),
  screenshots: z.boolean(),
  accessibilityEvents: z.boolean().default(false),
  stateRestore: z.boolean().default(false),
});

export const EnvironmentTelemetrySchema = z.object({
  osVersion: z.string(),
  architecture: z.string(),
  interactiveDesktop: z.boolean(),
  sessionStatus: z.enum(["OK", "BLOCKED_ENVIRONMENT"]),
  sessionReason: z.string().optional(),
  displaySummary: z.string().optional(),
  dpi: z.number().optional(),
  runtimeVersion: z.string(),
  backend: z.string(),
});

export const InitializeResultSchema = z.object({
  protocolVersion: z.string(),
  helperName: z.string(),
  helperVersion: z.string(),
  capabilities: HelperCapabilitiesSchema,
  environment: EnvironmentTelemetrySchema,
});

export const RpcBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export interface RpcNodeDto {
  readonly key: string;
  readonly role: string;
  readonly name: string;
  readonly context: string;
  readonly automationId?: string | undefined;
  readonly title?: string | undefined;
  readonly tooltip?: string | undefined;
  readonly value?: string | undefined;
  readonly bounds?: { x: number; y: number; width: number; height: number } | undefined;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly interactive: boolean;
  readonly supportedActions: string[];
  readonly identityConfidence: "HIGH" | "MEDIUM" | "LOW";
  readonly driverRef: string;
  readonly children: RpcNodeDto[];
}

export const RpcNodeDtoSchema: z.ZodType<RpcNodeDto, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    key: z.string(),
    role: z.string(),
    name: z.string(),
    context: z.string(),
    automationId: z.string().optional(),
    title: z.string().optional(),
    tooltip: z.string().optional(),
    value: z.string().optional(),
    bounds: RpcBoundsSchema.optional(),
    visible: z.boolean(),
    enabled: z.boolean(),
    interactive: z.boolean(),
    supportedActions: z.array(z.string()),
    identityConfidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    driverRef: z.string(),
    children: z.array(RpcNodeDtoSchema).default([]),
  }),
);

export const AttachTargetResultSchema = z.object({
  attached: z.boolean(),
  processId: z.number().int(),
  executablePath: z.string(),
  windowTitle: z.string(),
  reason: z.string().optional(),
});

export const DiscoverResultSchema = z.object({
  location: z.string(),
  stateHash: z.string(),
  nodes: z.array(RpcNodeDtoSchema),
  scrollLimitReached: z.boolean().optional(),
});

export const ExecuteActionResultSchema = z.object({
  attempted: z.boolean(),
  succeeded: z.boolean(),
  obscured: z.boolean(),
  unstable: z.boolean(),
  dispatchMayHaveHappened: z.boolean().optional(),
  unsupportedReason: z.string().optional(),
  foregroundProcessMismatch: z.boolean().optional(),
  signals: z
    .array(
      z.object({
        kind: z.enum([
          "url-change",
          "navigation",
          "dom-mutation",
          "accessibility-event",
          "state-change",
          "network-request",
          "network-blocked",
          "dialog",
          "popup",
          "download",
          "notification",
          "visual-change",
          "process-crash",
        ]),
        targetKey: z.string().optional(),
        detail: z.string(),
        inClickedSubtree: z.boolean(),
      }),
    )
    .default([]),
});

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: JsonRpcErrorObjectSchema.optional(),
});

export type InitializeResult = z.infer<typeof InitializeResultSchema>;
export type EnvironmentTelemetry = z.infer<typeof EnvironmentTelemetrySchema>;
export type AttachTargetResult = z.infer<typeof AttachTargetResultSchema>;
export type DiscoverResult = z.infer<typeof DiscoverResultSchema>;
export type ExecuteActionResult = z.infer<typeof ExecuteActionResultSchema>;
