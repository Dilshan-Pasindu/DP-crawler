import { createHash } from "node:crypto";
import type { UniversalNode } from "../model/index.js";

/**
 * Normalizes a label or identifier by splitting camelCase and delimiters,
 * lowercasing, and collapsing whitespace.
 */
export function normalizeName(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_/.,:;!?()[\]{}"'`~\\|@#$%^&*+=<>]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export interface ElementKeyInput {
  readonly role: string;
  readonly name: string;
  readonly context: string;
  readonly testId?: string;
  readonly elementId?: string;
  readonly ordinal?: number;
}

/**
 * Generates a deterministic, stable element identity key without relying on
 * transient native handles, timestamps, or screen coordinates.
 * Ordinal position is included only as a secondary tie-breaker when provided.
 */
export function buildElementKey(input: ElementKeyInput): string {
  const canonicalParts: string[] = [
    `role=${normalizeName(input.role)}`,
    `ctx=${normalizeName(input.context)}`,
  ];

  if (input.testId !== undefined && input.testId.trim().length > 0) {
    canonicalParts.push(`testid=${input.testId.trim()}`);
  } else if (input.elementId !== undefined && input.elementId.trim().length > 0) {
    canonicalParts.push(`elid=${input.elementId.trim()}`);
  } else {
    canonicalParts.push(`name=${normalizeName(input.name)}`);
  }

  if (input.ordinal !== undefined && input.ordinal > 0) {
    canonicalParts.push(`ord=${input.ordinal}`);
  }

  const digest = createHash("sha256").update(canonicalParts.join("|")).digest("hex").slice(0, 16);
  return `el_${digest}`;
}

/**
 * Flattens a tree of UniversalNodes in deterministic pre-order traversal.
 */
export function flattenNodes(nodes: readonly UniversalNode[]): UniversalNode[] {
  const result: UniversalNode[] = [];
  const visit = (list: readonly UniversalNode[]): void => {
    for (const node of list) {
      result.push(node);
      if (node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return result;
}
