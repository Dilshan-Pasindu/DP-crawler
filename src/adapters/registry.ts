import type { AdapterKind, PlatformAdapter } from "../model/index.js";

/**
 * Registry decoupling the shared brain and CLI from concrete platform adapters.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<AdapterKind, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.info.kind, adapter);
  }

  get(kind: AdapterKind): PlatformAdapter | undefined {
    return this.adapters.get(kind);
  }

  require(kind: AdapterKind): PlatformAdapter {
    const adapter = this.adapters.get(kind);
    if (adapter === undefined) {
      throw new Error(
        `Adapter "${kind}" is not registered or not yet implemented in this build.`,
      );
    }
    return adapter;
  }

  listKinds(): AdapterKind[] {
    return [...this.adapters.keys()];
  }
}

/**
 * Creates a default AdapterRegistry. Platform adapters are registered in Phases 2–6
 * as each platform reaches validated support.
 */
export function createDefaultRegistry(): AdapterRegistry {
  return new AdapterRegistry();
}
