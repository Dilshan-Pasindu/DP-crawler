import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildElementKey } from "../../brain/identity.js";
import {
  RunBlockedError,
  supportsAction,
  UnsupportedOperationError,
  type AdapterInfo,
  type AdapterSession,
  type InteractionExecutionResult,
  type PlatformAdapter,
  type SafetyProtection,
  type StateSnapshot,
  type TargetDescriptor,
  type UIAction,
  type UniversalNode,
} from "../../model/index.js";
import { HelperProcessManager } from "../../transports/process-manager.js";
import {
  AttachTargetResultSchema,
  DiscoverResultSchema,
  ExecuteActionResultSchema,
  RpcNodeDtoSchema,
  type RpcNodeDto,
} from "../../transports/protocol.js";
import { resolveWindowsHelperLaunch, verifyWindowsProcessBoundary } from "./process.js";

function mapDtoToUniversalNode(dto: RpcNodeDto): UniversalNode {
  const key = buildElementKey({
    role: dto.role,
    name: dto.name,
    context: dto.context,
    ...(dto.automationId !== undefined && dto.automationId.length > 0
      ? { elementId: dto.automationId }
      : {}),
  });

  return {
    key,
    role: dto.role,
    name: dto.name,
    context: dto.context,
    ...(dto.automationId !== undefined ? { elementId: dto.automationId } : {}),
    ...(dto.title !== undefined ? { title: dto.title } : {}),
    ...(dto.tooltip !== undefined ? { tooltip: dto.tooltip } : {}),
    ...(dto.value !== undefined ? { value: dto.value } : {}),
    ...(dto.bounds !== undefined ? { bounds: dto.bounds } : {}),
    visible: dto.visible,
    enabled: dto.enabled,
    interactive: dto.interactive,
    supportedActions: dto.supportedActions,
    identityConfidence: dto.identityConfidence,
    discoverySources: ["uia"],
    children: dto.children.map(mapDtoToUniversalNode),
    ref: {
      key,
      driverRef: dto.driverRef,
    },
  };
}

/**
 * Windows native UI Automation adapter backed by an isolated .NET 8 FlaUI helper
 * communicating via versioned JSON-RPC over stdio.
 */
export class WindowsUiaAdapter implements PlatformAdapter {
  readonly info: AdapterInfo = {
    kind: "windows-uia",
    platform: "windows",
    version: "0.1.0",
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
      accessibilityEvents: true,
      networkObservation: false,
      processMonitoring: true,
      stateRestore: true,
    },
  };

  async checkAvailability(target: TargetDescriptor): Promise<{
    readonly available: boolean;
    readonly details: readonly string[];
  }> {
    if (process.platform !== "win32" && target.windows?.helperCommand === undefined) {
      return {
        available: false,
        details: [
          `Windows UIA adapter requires a Windows host (current platform: ${process.platform}).`,
        ],
      };
    }

    const launch = resolveWindowsHelperLaunch(target);
    let manager: HelperProcessManager | null = null;
    try {
      manager = await HelperProcessManager.spawn({
        command: launch.command,
        args: launch.args,
      });
      const env = manager.initializeResult.environment;
      const details = [
        `OS: ${env.osVersion} (${env.architecture})`,
        `Runtime: ${env.runtimeVersion}, Backend: ${env.backend}`,
        `Session: ${env.sessionStatus}${env.sessionReason ? ` (${env.sessionReason})` : ""}`,
        ...(env.displaySummary ? [`Display: ${env.displaySummary}, DPI: ${String(env.dpi ?? 96)}`] : []),
      ];

      return {
        available: env.sessionStatus === "OK",
        details,
      };
    } catch (err) {
      return {
        available: false,
        details: [err instanceof Error ? err.message : String(err)],
      };
    } finally {
      if (manager !== null) {
        await manager.shutdown();
      }
    }
  }

  async openSession(target: TargetDescriptor): Promise<AdapterSession> {
    if (process.platform !== "win32" && target.windows?.helperCommand === undefined) {
      throw new RunBlockedError(
        "UNSUPPORTED_HOST_OS",
        `Windows UIA adapter cannot run on ${process.platform}.`,
      );
    }

    const launch = resolveWindowsHelperLaunch(target);
    const timeoutMs = target.windows?.operationTimeoutMs ?? 10_000;
    const manager = await HelperProcessManager.spawn({
      command: launch.command,
      args: launch.args,
    });

    try {
      const env = manager.initializeResult.environment;
      if (env.sessionStatus === "BLOCKED_ENVIRONMENT") {
        throw new RunBlockedError(
          "BLOCKED_ENVIRONMENT",
          env.sessionReason ?? "Interactive Windows desktop session is unavailable.",
        );
      }

      const rawAttach = await manager.client.request(
        "attachTarget",
        {
          entryPoint: target.entryPoint,
          processIdentity: target.processIdentity,
          startCommand: target.windows?.startCommand,
          backend: launch.backend,
        },
        timeoutMs,
      );
      const attachRes = AttachTargetResultSchema.parse(rawAttach);
      if (!attachRes.attached) {
        throw new RunBlockedError(
          "TARGET_ATTACH_FAILED",
          attachRes.reason ?? "Failed to attach Windows target process.",
        );
      }

      const boundary = verifyWindowsProcessBoundary(
        target.processIdentity,
        attachRes.executablePath,
      );
      if (!boundary.valid) {
        throw new RunBlockedError("PROCESS_BOUNDARY_MISMATCH", boundary.reason ?? "Process mismatch");
      }

      const sessionId = `win_${Date.now().toString(36)}`;
      const helperCaps = manager.initializeResult.capabilities;
      const adapterInfo: AdapterInfo = {
        ...this.info,
        runtimeVersion: `${env.runtimeVersion} / ${env.backend}`,
        capabilities: {
          ...this.info.capabilities,
          discovery: helperCaps.discovery,
          invoke: helperCaps.invoke,
          setValue: helperCaps.setValue,
          toggle: helperCaps.toggle,
          select: helperCaps.select,
          expand: helperCaps.expand,
          collapse: helperCaps.collapse,
          focus: helperCaps.focus,
          keyboard: helperCaps.keyboard,
          pointer: helperCaps.pointer,
          scrolling: helperCaps.scrolling,
          screenshots: helperCaps.screenshots,
          accessibilityEvents: helperCaps.accessibilityEvents,
          stateRestore: helperCaps.stateRestore,
        },
      };

      const evidenceRunDir = path.join(
        target.evidence?.outputDir ?? "reports",
        "evidence",
        target.evidence?.runId ?? sessionId,
      );

      return {
        sessionId,
        adapterInfo,

        async getSafetyCoverage(): Promise<readonly SafetyProtection[]> {
          return [
            { name: "desktop-process-scoping", active: true, required: true },
            { name: "target-window-scoping", active: true, required: true },
            { name: "uac-system-prompt-guard", active: true, required: true },
            {
              name: "http-interception",
              active: false,
              required: false,
              reason: "Browser network guard is unavailable for native Windows desktop operations",
            },
          ];
        },

        async discover(): Promise<StateSnapshot> {
          const raw = await manager.client.request("discover", {}, timeoutMs);
          const parsed = DiscoverResultSchema.parse(raw);
          return {
            location: parsed.location,
            stateHash: parsed.stateHash,
            nodes: parsed.nodes.map(mapDtoToUniversalNode),
            ...(parsed.scrollLimitReached !== undefined
              ? { scrollLimitReached: parsed.scrollLimitReached }
              : {}),
          };
        },

        async resolveNode(node: UniversalNode): Promise<UniversalNode | null> {
          const raw = await manager.client.request(
            "resolveNode",
            {
              key: node.key,
              role: node.role,
              name: node.name,
              context: node.context,
              automationId: node.elementId,
              driverRef: node.ref.driverRef,
            },
            timeoutMs,
          );
          if (raw === null || raw === undefined) {
            return null;
          }
          const dto = RpcNodeDtoSchema.parse(raw);
          return mapDtoToUniversalNode(dto);
        },

        async executeAction(node: UniversalNode, action: UIAction): Promise<InteractionExecutionResult> {
          if (!supportsAction(adapterInfo.capabilities, action.type)) {
            throw new UnsupportedOperationError(adapterInfo.kind, action.type);
          }

          try {
            const raw = await manager.client.request(
              "executeAction",
              {
                nodeKey: node.key,
                driverRef: node.ref.driverRef,
                role: node.role,
                name: node.name,
                automationId: node.elementId,
                action,
              },
              timeoutMs,
            );
            const res = ExecuteActionResultSchema.parse(raw);
            const mappedSignals = res.signals.map((s) => ({
              kind: s.kind,
              detail: s.detail,
              inClickedSubtree: s.inClickedSubtree,
              ...(s.targetKey !== undefined ? { targetKey: s.targetKey } : {}),
            }));

            if (res.foregroundProcessMismatch === true) {
              return {
                attempted: false,
                succeeded: false,
                obscured: true,
                unstable: false,
                dispatchMayHaveHappened: false,
                unsupportedReason: "Foreground window belongs to an unrelated or system process",
                signals: mappedSignals,
              };
            }

            return {
              attempted: res.attempted,
              succeeded: res.succeeded,
              obscured: res.obscured,
              unstable: res.unstable,
              ...(res.dispatchMayHaveHappened !== undefined
                ? { dispatchMayHaveHappened: res.dispatchMayHaveHappened }
                : {}),
              ...(res.unsupportedReason !== undefined
                ? { unsupportedReason: res.unsupportedReason }
                : {}),
              signals: mappedSignals,
            };
          } catch (err) {
            if (!manager.isAlive()) {
              return {
                attempted: true,
                succeeded: false,
                obscured: false,
                unstable: false,
                dispatchMayHaveHappened: true,
                signals: [
                  {
                    kind: "process-crash",
                    targetKey: node.key,
                    detail: err instanceof Error ? err.message : String(err),
                    inClickedSubtree: false,
                    error: {
                      code: "HELPER_CRASH",
                      category: "helper-failure",
                      message: err instanceof Error ? err.message : String(err),
                      source: "application",
                    },
                  },
                ],
              };
            }
            throw err;
          }
        },

        async captureScreenshot(label: string): Promise<string | null> {
          if (!adapterInfo.capabilities.screenshots || target.evidence?.screenshots === false) {
            return null;
          }
          const raw = await manager.client.request("captureScreenshot", { label }, timeoutMs);
          if (raw === null || typeof raw !== "object" || !("pngBase64" in raw)) {
            return null;
          }
          const b64 = (raw as { pngBase64?: unknown }).pngBase64;
          if (typeof b64 !== "string" || b64.length === 0) {
            return null;
          }
          mkdirSync(evidenceRunDir, { recursive: true });
          const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
          const outPath = path.join(evidenceRunDir, `${safeLabel}.png`);
          writeFileSync(outPath, Buffer.from(b64, "base64"));
          return outPath;
        },

        async restoreState(): Promise<{ readonly ok: boolean; readonly reason?: string }> {
          if (!adapterInfo.capabilities.stateRestore) {
            return { ok: false, reason: "stateRestore not supported" };
          }
          const raw = await manager.client.request("restoreState", {}, timeoutMs);
          if (typeof raw === "object" && raw !== null && "ok" in raw) {
            const obj = raw as { ok?: unknown; reason?: unknown };
            return {
              ok: obj.ok === true,
              ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
            };
          }
          return { ok: false, reason: "Invalid restoreState response from helper" };
        },

        async dispose(): Promise<void> {
          await manager.shutdown();
        },
      };
    } catch (err) {
      await manager.shutdown();
      throw err;
    }
  }
}
