import { buildElementKey } from "../../src/brain/identity.js";
import {
  supportsAction,
  UnsupportedOperationError,
  type AdapterCapabilities,
  type AdapterInfo,
  type AdapterSession,
  type InteractionExecutionResult,
  type Platform,
  type PlatformAdapter,
  type SafetyProtection,
  type StateSnapshot,
  type TargetDescriptor,
  type UIAction,
  type UniversalNode,
} from "../../src/model/index.js";

export interface MockScenarioBehavior {
  readonly nodesByLocation: Record<string, readonly UniversalNode[]>;
  readonly initialLocation: string;
  readonly actionHandlers?: Record<
    string,
    (attempt: number, action: UIAction) => InteractionExecutionResult & { readonly nextLocation?: string }
  >;
  readonly protections?: readonly SafetyProtection[];
  readonly restoreSucceeds?: boolean;
  readonly available?: boolean;
}

export function makeMockNode(params: {
  readonly role: string;
  readonly name: string;
  readonly context: string;
  readonly testId?: string;
  readonly elementId?: string;
  readonly destination?: string;
  readonly visible?: boolean;
  readonly enabled?: boolean;
  readonly interactive?: boolean;
  readonly supportedActions?: readonly string[];
  readonly identityConfidence?: "HIGH" | "MEDIUM" | "LOW";
  readonly discoverySources?: readonly ("dom" | "uia" | "accessibility" | "ocr" | "visual")[];
  readonly bounds?: { x: number; y: number; width: number; height: number };
  readonly children?: readonly UniversalNode[];
}): UniversalNode {
  const key = buildElementKey({
    role: params.role,
    name: params.name,
    context: params.context,
    ...(params.testId !== undefined ? { testId: params.testId } : {}),
    ...(params.elementId !== undefined ? { elementId: params.elementId } : {}),
  });

  return {
    key,
    role: params.role,
    name: params.name,
    context: params.context,
    ...(params.testId !== undefined ? { testId: params.testId } : {}),
    ...(params.elementId !== undefined ? { elementId: params.elementId } : {}),
    ...(params.destination !== undefined ? { destination: params.destination } : {}),
    ...(params.bounds !== undefined ? { bounds: params.bounds } : {}),
    visible: params.visible ?? true,
    enabled: params.enabled ?? true,
    interactive: params.interactive ?? true,
    supportedActions: params.supportedActions ?? ["invoke"],
    identityConfidence:
      params.identityConfidence ?? (params.testId !== undefined || params.elementId !== undefined ? "HIGH" : "MEDIUM"),
    discoverySources: params.discoverySources ?? ["dom"],
    children: params.children ?? [],
    ref: {
      key,
      driverRef: `mock-ref://${key}`,
    },
  };
}

export class MockAdapter implements PlatformAdapter {
  readonly info: AdapterInfo;
  private readonly scenario: MockScenarioBehavior;
  private sessionCounter = 0;

  constructor(params: {
    readonly platform?: Platform;
    readonly capabilities?: Partial<AdapterCapabilities>;
    readonly scenario: MockScenarioBehavior;
  }) {
    this.scenario = params.scenario;
    this.info = {
      kind: "mock",
      platform: params.platform ?? "web",
      version: "1.0.0",
      runtimeVersion: "mock-runtime-1.0",
      capabilities: {
        discovery: true,
        invoke: true,
        setValue: true,
        toggle: true,
        select: true,
        expand: true,
        collapse: true,
        focus: true,
        keyboard: false,
        pointer: false,
        scrolling: true,
        screenshots: true,
        accessibilityEvents: false,
        networkObservation: true,
        processMonitoring: false,
        stateRestore: true,
        ...params.capabilities,
      },
    };
  }

  async checkAvailability(_target: TargetDescriptor): Promise<{
    readonly available: boolean;
    readonly details: readonly string[];
  }> {
    const available = this.scenario.available ?? true;
    return {
      available,
      details: available ? ["Mock runtime ready"] : ["Mock runtime unavailable"],
    };
  }

  async openSession(_target: TargetDescriptor): Promise<AdapterSession> {
    this.sessionCounter += 1;
    const sessionId = `mock_session_${this.sessionCounter}`;
    let currentLocation = this.scenario.initialLocation;
    let disposed = false;
    const attemptCounts = new Map<string, number>();

    const info = this.info;
    const scenario = this.scenario;

    return {
      sessionId,
      adapterInfo: info,

      async getSafetyCoverage(): Promise<readonly SafetyProtection[]> {
        return (
          scenario.protections ?? [
            { name: "http-interception", active: info.capabilities.networkObservation, required: true },
            { name: "target-scoping", active: true, required: true },
          ]
        );
      },

      async discover(): Promise<StateSnapshot> {
        if (disposed) throw new Error("Session disposed");
        const nodes = scenario.nodesByLocation[currentLocation] ?? [];
        return {
          location: currentLocation,
          stateHash: `hash_${currentLocation}_${nodes.length}`,
          nodes,
        };
      },

      async resolveNode(node: UniversalNode): Promise<UniversalNode | null> {
        const nodes = scenario.nodesByLocation[currentLocation] ?? [];
        return nodes.find((n) => n.key === node.key) ?? null;
      },

      async executeAction(node: UniversalNode, action: UIAction): Promise<InteractionExecutionResult> {
        if (disposed) throw new Error("Session disposed");
        if (!supportsAction(info.capabilities, action.type)) {
          throw new UnsupportedOperationError(info.kind, action.type);
        }

        const nextAttempt = (attemptCounts.get(node.key) ?? 0) + 1;
        attemptCounts.set(node.key, nextAttempt);

        const handler = scenario.actionHandlers?.[node.key];
        if (handler !== undefined) {
          const result = handler(nextAttempt, action);
          if (result.nextLocation !== undefined) {
            currentLocation = result.nextLocation;
          }
          return result;
        }

        return {
          attempted: true,
          succeeded: true,
          obscured: false,
          unstable: false,
          signals: [
            {
              kind: "dom-mutation",
              targetKey: node.key,
              detail: `Executed ${action.type} on ${node.name}`,
              inClickedSubtree: true,
            },
          ],
        };
      },

      async captureScreenshot(label: string): Promise<string | null> {
        if (!info.capabilities.screenshots) {
          return null;
        }
        return `evidence/${sessionId}/${label}.png`;
      },

      async restoreState(): Promise<{ readonly ok: boolean; readonly reason?: string }> {
        if (!info.capabilities.stateRestore) {
          return { ok: false, reason: "stateRestore not supported" };
        }
        if (scenario.restoreSucceeds === false) {
          return { ok: false, reason: "Simulated restore failure" };
        }
        currentLocation = scenario.initialLocation;
        return { ok: true };
      },

      async dispose(): Promise<void> {
        disposed = true;
      },
    };
  }
}

export function makeDefaultTarget(overrides?: Partial<TargetDescriptor>): TargetDescriptor {
  return {
    id: "mock-app",
    name: "Mock App",
    platform: "web",
    adapter: "mock",
    entryPoint: "http://localhost:5173/",
    allowedOrigins: ["http://localhost:5173"],
    isRemote: false,
    safety: {
      confirmRemote: false,
      testDataConfirmed: false,
      verificationLevel: "MEDIUM",
      allowMutationsOnVerifiedEnv: false,
      globalDenyTerms: [],
      targetDenyTerms: [],
      profileDenyTerms: [],
      exceptions: [],
      network: {
        allowHttpMutations: [],
        denyEndpoints: [],
        allowWebSocketConnections: [],
      },
    },
    ...overrides,
  };
}
