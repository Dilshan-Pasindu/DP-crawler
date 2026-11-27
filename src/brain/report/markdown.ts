import type { CrawlReport, Finding } from "../../model/index.js";

/**
 * Escapes untrusted application text before embedding in Markdown.
 */
export function escapeMarkdown(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+\-!|])/g, "\\$1");
}

function renderFindingSection(finding: Finding): string {
  const limitations =
    finding.limitations.length > 0
      ? finding.limitations.map(escapeMarkdown).join("; ")
      : "None";

  return [
    `### ${finding.id} — ${escapeMarkdown(finding.elementName)} (${escapeMarkdown(finding.elementRole)})`,
    "",
    `- **Severity:** ${finding.severity}`,
    `- **Status:** ${finding.status}`,
    `- **Target:** ${escapeMarkdown(finding.targetId)}`,
    `- **Element Identity:** \`${finding.elementKey}\` (confidence: ${finding.identityConfidence})`,
    `- **Outcome:** ${finding.outcome} (confirmed: ${finding.confirmed ? "yes" : "no"})`,
    `- **Reproduction Path:** ${finding.reproductionPath.map(escapeMarkdown).join(" -> ")}`,
    `- **Error Summary:** ${escapeMarkdown(finding.errorSummary)}`,
    `- **Evidence Reference:** ${finding.evidenceRef !== undefined ? `\`${escapeMarkdown(finding.evidenceRef)}\`` : "None"}`,
    `- **Attribution Confidence:** ${finding.attributionConfidence}`,
    `- **Limitations:** ${limitations}`,
    "",
  ].join("\n");
}

/**
 * Renders actionable findings in Markdown (`bugs.md`), escaping all untrusted text.
 */
export function renderMarkdownReport(report: CrawlReport): string {
  const header = [
    `# DP Crawler Findings — ${escapeMarkdown(report.targetId)}`,
    "",
    `- **Platform / Adapter:** ${report.platform} / ${report.adapter.kind} v${report.adapter.version}`,
    `- **Completion Status:** ${report.completionStatus}${report.completionReason !== undefined ? ` (${escapeMarkdown(report.completionReason)})` : ""}`,
    `- **Verification Level:** ${report.verificationLevel}`,
    `- **Coverage:** discovered=${report.coverage.discovered}, tested=${report.coverage.tested}, blocked=${report.coverage.blocked}, notTested=${report.coverage.notTested}, failed=${report.coverage.failed}`,
    "",
  ].join("\n");

  if (report.findings.length === 0) {
    return `${header}No findings detected.\n`;
  }

  return `${header}${report.findings.map(renderFindingSection).join("\n")}`;
}
