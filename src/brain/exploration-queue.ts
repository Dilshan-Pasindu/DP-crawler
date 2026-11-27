import type { UIAction, UniversalNode } from "../model/index.js";

export interface QueueItem {
  readonly node: UniversalNode;
  readonly action: UIAction;
  readonly depth: number;
  readonly path: readonly string[];
  readonly stateFingerprint: string;
}

export interface QueueLimits {
  readonly maxDepth: number;
  readonly maxRediscoveryPerState: number;
}

/**
 * Bounded exploration queue preventing infinite rediscovery via element/action/state
 * deduplication, per-state rediscovery caps, and maxDepth enforcement.
 */
export class ExplorationQueue {
  private readonly items: QueueItem[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly stateDiscoveryCounts = new Map<string, number>();
  private readonly limits: QueueLimits;

  constructor(limits: QueueLimits) {
    this.limits = limits;
  }

  /**
   * Records a state visit and returns whether rediscovery is still within bounds.
   */
  recordStateDiscovery(stateFingerprint: string): boolean {
    const current = this.stateDiscoveryCounts.get(stateFingerprint) ?? 0;
    const next = current + 1;
    this.stateDiscoveryCounts.set(stateFingerprint, next);
    return next <= this.limits.maxRediscoveryPerState;
  }

  /**
   * Enqueues an item if within depth bounds and not previously queued for this element/action.
   * Upgrades an unvisited queued item if rediscovery reveals it became visible and enabled.
   */
  enqueue(item: QueueItem): boolean {
    if (item.depth > this.limits.maxDepth) {
      return false;
    }
    const dedupKey = `${item.node.key}::${item.action.type}`;
    if (this.seenKeys.has(dedupKey)) {
      const pendingIndex = this.items.findIndex(
        (existing) => `${existing.node.key}::${existing.action.type}` === dedupKey,
      );
      if (pendingIndex >= 0) {
        const existing = this.items[pendingIndex];
        const wasUnavailable = existing !== undefined && (!existing.node.visible || !existing.node.enabled);
        if (wasUnavailable && item.node.visible && item.node.enabled) {
          this.items[pendingIndex] = item;
          return true;
        }
      }
      return false;
    }
    this.seenKeys.add(dedupKey);
    this.items.push(item);
    return true;
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  size(): number {
    return this.items.length;
  }

  drainRemaining(): QueueItem[] {
    return this.items.splice(0, this.items.length);
  }
}
