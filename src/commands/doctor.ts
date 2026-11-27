import type { AdapterRegistry } from "../adapters/registry.js";
import { getProfile, loadConfigFile, profileToTargetDescriptor } from "../config.js";

export interface DoctorCheckResult {
  readonly ok: boolean;
  readonly profile: string;
  readonly adapterKind: string;
  readonly details: readonly string[];
}

/**
 * Checks configuration validity, adapter registration, and runtime availability.
 */
export async function runDoctorCommand(params: {
  readonly configPath: string;
  readonly profileName: string;
  readonly registry: AdapterRegistry;
}): Promise<DoctorCheckResult> {
  const config = await loadConfigFile(params.configPath);
  const profile = getProfile(config, params.profileName);
  const target = profileToTargetDescriptor(params.profileName, profile);

  const adapter = params.registry.get(target.adapter);
  if (adapter === undefined) {
    return {
      ok: false,
      profile: params.profileName,
      adapterKind: target.adapter,
      details: [
        "Configuration valid.",
        `Adapter "${target.adapter}" for platform "${target.platform}" is not available in this build yet.`,
      ],
    };
  }

  const availability = await adapter.checkAvailability(target);
  return {
    ok: availability.available,
    profile: params.profileName,
    adapterKind: target.adapter,
    details: ["Configuration valid.", ...availability.details],
  };
}
