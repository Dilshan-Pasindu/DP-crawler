import escapeHtml from "escape-html";
import type { CrawlReport, ElementOutcomeRecord, Finding } from "../../model/index.js";

function renderFindingRow(finding: Finding): string {
  const pathText = escapeHtml(finding.reproductionPath.join(" -> "));
  const evidenceText = finding.evidenceRef !== undefined ? escapeHtml(finding.evidenceRef) : "None";
  return `<details class="card finding">
  <summary>
    <span class="badge badge-${escapeHtml(finding.severity.toLowerCase())}">${escapeHtml(finding.severity)}</span>
    <strong>${escapeHtml(finding.id)}</strong>
    <span>[${escapeHtml(finding.status)}]</span>
    <span>${escapeHtml(finding.category)}</span> — ${escapeHtml(finding.elementName)} (${escapeHtml(finding.elementRole)})
  </summary>
  <div class="details-body">
    <p><strong>Outcome:</strong> ${escapeHtml(finding.outcome)} | <strong>Confirmed:</strong> ${finding.confirmed ? "Yes" : "No (unconfirmed)"}</p>
    <p><strong>Identity Confidence:</strong> ${escapeHtml(finding.identityConfidence)} | <strong>Attribution Confidence:</strong> ${escapeHtml(finding.attributionConfidence)}</p>
    <p><strong>Error:</strong> ${escapeHtml(finding.errorSummary)}</p>
    <p><strong>Reproduction Path:</strong> <code>${pathText}</code></p>
    <p><strong>Evidence:</strong> <code>${evidenceText}</code></p>
  </div>
</details>`;
}

function renderOutcomeRow(record: ElementOutcomeRecord): string {
  return `<tr>
  <td><code>${escapeHtml(record.elementKey)}</code></td>
  <td>${escapeHtml(record.role)}</td>
  <td>${escapeHtml(record.name)}</td>
  <td><span class="badge">${escapeHtml(record.outcome)}</span></td>
  <td>${escapeHtml(record.identityConfidence)}</td>
  <td>${escapeHtml(record.reason ?? "")}</td>
</tr>`;
}

/**
 * Renders a self-contained, offline-capable HTML report with strict CSP and full escaping
 * of all untrusted application-provided values.
 */
export function renderHtmlReport(report: CrawlReport): string {
  const blockedOrUntested = report.elementOutcomes.filter(
    (o) => o.outcome === "BLOCKED" || o.outcome === "NOT_TESTED" || o.outcome === "RESTORE_FAILED",
  );
  const findingsHtml =
    report.findings.length > 0
      ? report.findings.map(renderFindingRow).join("\n")
      : "<p>No findings detected.</p>";
  const blockedHtml =
    blockedOrUntested.length > 0
      ? `<table><thead><tr><th>Key</th><th>Role</th><th>Name</th><th>Outcome</th><th>Identity</th><th>Reason</th></tr></thead><tbody>${blockedOrUntested.map(renderOutcomeRow).join("\n")}</tbody></table>`
      : "<p>No blocked or untested elements.</p>";
  const allOutcomesHtml = report.elementOutcomes.map(renderOutcomeRow).join("\n");

  const activeProtections = report.safetyCoverage.activeProtections
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join("");
  const unavailableProtections = report.safetyCoverage.unavailableProtections
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join("");
  const limitationsHtml = report.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;">
  <title>DP Crawler Report — ${escapeHtml(report.targetId)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; line-height: 1.5; color: #1f2937; background: #f9fafb; }
    h1, h2 { color: #111827; }
    .meta, .grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 1.5rem; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.9rem 1rem; margin-bottom: 0.75rem; }
    .badge { display: inline-block; padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.78rem; font-weight: 600; background: #e5e7eb; }
    .badge-critical, .badge-high { background: #fee2e2; color: #991b1b; }
    .badge-medium { background: #fef3c7; color: #92400e; }
    .badge-low, .badge-info { background: #dbeafe; color: #1e40af; }
    table { width: 100%; border-collapse: collapse; background: #fff; font-size: 0.9rem; }
    th, td { border: 1px solid #e5e7eb; padding: 0.5rem; text-align: left; }
    th { background: #f3f4f6; }
    .details-body { margin-top: 0.65rem; padding-top: 0.65rem; border-top: 1px solid #f3f4f6; }
  </style>
</head>
<body>
  <h1>DP Crawler Diagnostic Report</h1>
  <div class="meta">
    <div class="card"><strong>Target:</strong><br>${escapeHtml(report.targetId)} (${escapeHtml(report.platform)})</div>
    <div class="card"><strong>Adapter:</strong><br>${escapeHtml(report.adapter.kind)} v${escapeHtml(report.adapter.version)}</div>
    <div class="card"><strong>Status:</strong><br>${escapeHtml(report.completionStatus)}</div>
    <div class="card"><strong>Verification:</strong><br>${escapeHtml(report.verificationLevel)}</div>
  </div>

  <h2>Coverage</h2>
  <div class="grid">
    <div class="card">Discovered: <strong>${report.coverage.discovered}</strong></div>
    <div class="card">Tested: <strong>${report.coverage.tested}</strong></div>
    <div class="card">Blocked: <strong>${report.coverage.blocked}</strong></div>
    <div class="card">Not Tested: <strong>${report.coverage.notTested}</strong></div>
    <div class="card">Failed: <strong>${report.coverage.failed}</strong></div>
    <div class="card">Dead: <strong>${report.coverage.dead}</strong></div>
  </div>

  <h2>Active &amp; Unavailable Safety Protections</h2>
  <div class="card">
    <strong>Active:</strong><ul>${activeProtections || "<li>None</li>"}</ul>
    <strong>Unavailable:</strong><ul>${unavailableProtections || "<li>None</li>"}</ul>
    ${limitationsHtml ? `<strong>Limitations:</strong><ul>${limitationsHtml}</ul>` : ""}
  </div>

  <h2>Findings (${report.findings.length})</h2>
  ${findingsHtml}

  <h2>Blocked &amp; Untested Elements (${blockedOrUntested.length})</h2>
  ${blockedHtml}

  <details class="card">
    <summary><strong>All Element Outcomes (${report.elementOutcomes.length})</strong></summary>
    <div class="details-body">
      <table>
        <thead><tr><th>Key</th><th>Role</th><th>Name</th><th>Outcome</th><th>Identity</th><th>Reason</th></tr></thead>
        <tbody>${allOutcomesHtml}</tbody>
      </table>
    </div>
  </details>
</body>
</html>
`;
}
