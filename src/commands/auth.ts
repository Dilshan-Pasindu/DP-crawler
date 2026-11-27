import { getProfile, loadConfigFile } from "../config.js";

/**
 * Manages authentication setup (`dpcrawl auth`).
 * Interactive credential capture is implemented per platform adapter in Phase 2+.
 */
export async function runAuthCommand(params: {
  readonly configPath: string;
  readonly profileName: string;
}): Promise<{ readonly mode: string; readonly message: string }> {
  const config = await loadConfigFile(params.configPath);
  const profile = getProfile(config, params.profileName);
  return {
    mode: profile.auth.mode,
    message: `Authentication workflow "${profile.auth.mode}" for profile "${params.profileName}" requires a platform adapter session (Phase 2+). Never store raw credentials in config or reports.`,
  };
}
