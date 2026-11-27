import { readFile } from "node:fs/promises";
import { generateAcceptSuggestion, type SuggestedAcceptanceOutput } from "../brain/baseline.js";
import type { CrawlReport } from "../model/index.js";

/**
 * Generates suggested baseline acceptance configuration from a report for human review.
 * Never mutates baseline files automatically.
 */
export async function runAcceptCommand(
  reportPath: string,
  generatedAt: string = new Date().toISOString(),
): Promise<SuggestedAcceptanceOutput> {
  const raw = await readFile(reportPath, "utf8");
  const report = JSON.parse(raw) as CrawlReport;
  return generateAcceptSuggestion(report.findings, generatedAt);
}
