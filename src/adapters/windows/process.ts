import { existsSync } from "node:fs";
import path from "node:path";
import type { TargetDescriptor } from "../../model/index.js";

export interface HelperLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly backend: "uia3" | "uia2";
}

/**
 * Resolves the launch command and arguments for the isolated Windows FlaUI helper process.
 * Defaults strictly to UIA3; UIA2 fallback is enabled only when explicitly configured.
 */
export function resolveWindowsHelperLaunch(target: TargetDescriptor): HelperLaunchSpec {
  const backend = target.windows?.uiaBackend ?? "uia3";

  if (target.windows?.helperCommand !== undefined) {
    return {
      command: target.windows.helperCommand,
      args: target.windows.helperArgs ?? [],
      backend,
    };
  }

  const publishedExe = path.resolve(
    process.cwd(),
    "native/windows-helper/bin/Release/net8.0-windows/win-x64/WindowsHelper.exe",
  );
  if (existsSync(publishedExe)) {
    return {
      command: publishedExe,
      args: ["--backend", backend],
      backend,
    };
  }

  return {
    command: "dotnet",
    args: [
      "run",
      "--project",
      path.resolve(process.cwd(), "native/windows-helper/WindowsHelper.csproj"),
      "-c",
      "Release",
      "--",
      "--backend",
      backend,
    ],
    backend,
  };
}

/**
 * Verifies that an attached Windows process matches the configured target boundary.
 */
export function verifyWindowsProcessBoundary(
  expectedIdentity: string | undefined,
  actualExecutablePath: string,
): { readonly valid: boolean; readonly reason?: string } {
  if (expectedIdentity === undefined || expectedIdentity.trim().length === 0) {
    return { valid: true };
  }

  const normalizedExpected = expectedIdentity.replace(/\\/g, "/").toLowerCase();
  const normalizedActual = actualExecutablePath.replace(/\\/g, "/").toLowerCase();
  const actualBase = path.posix.basename(normalizedActual);

  if (normalizedActual === normalizedExpected || actualBase === normalizedExpected) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `Process identity mismatch: expected "${expectedIdentity}", got "${actualExecutablePath}"`,
  };
}
