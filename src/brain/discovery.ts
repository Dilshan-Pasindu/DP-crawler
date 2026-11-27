import { createHash } from "node:crypto";
import type { Bounds, DiscoverySource, UniversalNode } from "../model/index.js";
import { normalizeName } from "./identity.js";

function boundsOverlapSubstantially(a: Bounds, b: Bounds): boolean {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = xOverlap * yOverlap;
  if (intersection <= 0) {
    return false;
  }
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;
  return union > 0 && intersection / union >= 0.5;
}

function canMergeNodes(primary: UniversalNode, candidate: UniversalNode): boolean {
  if (primary.testId !== undefined && candidate.testId !== undefined && primary.testId === candidate.testId) {
    return true;
  }
  if (
    primary.elementId !== undefined &&
    candidate.elementId !== undefined &&
    primary.elementId === candidate.elementId &&
    primary.role === candidate.role
  ) {
    return true;
  }

  // Never merge solely on visible text or overlapping boxes alone:
  // require matching role + normalized name + parent context + corroborated bounds (when present).
  const sameSemanticIdentity =
    normalizeName(primary.role) === normalizeName(candidate.role) &&
    normalizeName(primary.name) === normalizeName(candidate.name) &&
    normalizeName(primary.context) === normalizeName(candidate.context) &&
    normalizeName(primary.name).length > 0;

  if (!sameSemanticIdentity) {
    return false;
  }

  if (primary.bounds !== undefined && candidate.bounds !== undefined) {
    return boundsOverlapSubstantially(primary.bounds, candidate.bounds);
  }

  return false;
}

function unionSources(
  a: readonly DiscoverySource[],
  b: readonly DiscoverySource[],
): DiscoverySource[] {
  const set = new Set<DiscoverySource>([...a, ...b]);
  return [...set];
}

/**
 * Merges secondary discovery candidates (e.g. OCR/visual) into primary semantic nodes
 * only when corroborating evidence supports a match, retaining all discovery sources.
 */
export function mergeDiscovery(
  primaryNodes: readonly UniversalNode[],
  secondaryNodes: readonly UniversalNode[],
): UniversalNode[] {
  const merged: UniversalNode[] = primaryNodes.map((n) => ({
    ...n,
    discoverySources: [...n.discoverySources],
  }));

  for (const candidate of secondaryNodes) {
    const matchIndex = merged.findIndex((existing) => canMergeNodes(existing, candidate));
    if (matchIndex >= 0) {
      const existing = merged[matchIndex];
      if (existing !== undefined) {
        merged[matchIndex] = {
          ...existing,
          discoverySources: unionSources(existing.discoverySources, candidate.discoverySources),
        };
      }
    } else {
      merged.push(candidate);
    }
  }

  return merged;
}

/**
 * Computes a deterministic state fingerprint from location and discovered element keys.
 */
export function fingerprintState(location: string, nodes: readonly UniversalNode[]): string {
  const sortedKeys = nodes
    .map((n) => `${n.key}:${n.enabled ? "1" : "0"}:${n.visible ? "1" : "0"}`)
    .sort();
  return createHash("sha256")
    .update(`${location}|${sortedKeys.join(",")}`)
    .digest("hex")
    .slice(0, 16);
}
