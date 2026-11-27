import type { CoverageReport, ElementOutcomeRecord } from "../model/index.js";

/**
 * Tracks typed coverage metrics across discovered and interacted UI elements.
 */
export class CoverageTracker {
  private readonly discoveredKeys = new Set<string>();
  private readonly outcomesByKey = new Map<string, ElementOutcomeRecord>();
  private reachedDepth = 0;
  private scrollLimitReached = false;
  private rediscoveryCount = 0;

  recordDiscovered(elementKeys: readonly string[], depth: number, isRediscovery: boolean): void {
    for (const key of elementKeys) {
      this.discoveredKeys.add(key);
    }
    if (depth > this.reachedDepth) {
      this.reachedDepth = depth;
    }
    if (isRediscovery) {
      this.rediscoveryCount += 1;
    }
  }

  markScrollLimitReached(): void {
    this.scrollLimitReached = true;
  }

  recordOutcome(record: ElementOutcomeRecord): void {
    this.discoveredKeys.add(record.elementKey);
    this.outcomesByKey.set(record.elementKey, record);
  }

  buildReport(): CoverageReport {
    let tested = 0;
    let blocked = 0;
    let notTested = 0;
    let failed = 0;
    let flaky = 0;
    let obscured = 0;
    let dead = 0;

    for (const record of this.outcomesByKey.values()) {
      switch (record.outcome) {
        case "PASS":
          tested += 1;
          break;
        case "FAIL":
          tested += 1;
          failed += 1;
          break;
        case "FLAKY":
          tested += 1;
          flaky += 1;
          break;
        case "DEAD":
          tested += 1;
          dead += 1;
          break;
        case "OBSCURED":
          obscured += 1;
          break;
        case "BLOCKED":
          blocked += 1;
          break;
        case "RESTORE_FAILED":
        case "NOT_TESTED":
          notTested += 1;
          break;
      }
    }

    const unvisited = Math.max(0, this.discoveredKeys.size - this.outcomesByKey.size);

    return {
      discovered: this.discoveredKeys.size,
      tested,
      blocked,
      notTested,
      failed,
      flaky,
      obscured,
      dead,
      unvisited,
      reachedDepth: this.reachedDepth,
      scrollLimitReached: this.scrollLimitReached,
      rediscoveryCount: this.rediscoveryCount,
    };
  }
}
