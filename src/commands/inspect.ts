import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterRegistry } from "../adapters/registry.js";
import { evaluateSafetyCoverage } from "../brain/safety.js";
import { getProfile, loadConfigFile, profileToTargetDescriptor } from "../config.js";
import type { StateSnapshot } from "../model/index.js";

export interface DiscoveryOutput {
  readonly schemaVersion: string;
  readonly profile: string;
  readonly targetId: string;
  readonly safetyCoverage: ReturnType<typeof evaluateSafetyCoverage>;
  readonly snapshot: StateSnapshot;
}

/**
 * Discovery-only command (`dpcrawl inspect`). Never executes UI interaction actions.
 */
export async function runInspectCommand(params: {
  readonly configPath: string;
  readonly profileName: string;
  readonly registry: AdapterRegistry;
  readonly outputFile?: string;
}): Promise<DiscoveryOutput> {
  const config = await loadConfigFile(params.configPath);
  const profile = getProfile(config, params.profileName);
  const target = profileToTargetDescriptor(params.profileName, profile);
  const adapter = params.registry.require(target.adapter);

  const session = await adapter.openSession(target);
  try {
    const protections = await session.getSafetyCoverage();
    const safetyCoverage = evaluateSafetyCoverage(protections);
    if (!safetyCoverage.fullCoverage) {
      throw new Error(
        `RUN_BLOCKED: Missing required safety protections: ${safetyCoverage.missingRequiredProtections.join(", ")}`,
      );
    }

    const snapshot = await session.discover();
    const output: DiscoveryOutput = {
      schemaVersion: "1.0.0",
      profile: params.profileName,
      targetId: target.id,
      safetyCoverage,
      snapshot,
    };

    const dest = params.outputFile ?? path.join(profile.evidence.outputDir, "discovery.json");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return output;
  } finally {
    await session.dispose();
  }
}
