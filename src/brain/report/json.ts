import type { CrawlReport } from "../../model/index.js";

/**
 * Serializes the authoritative CrawlReport to formatted JSON.
 */
export function renderJsonReport(report: CrawlReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
