import type { CrawlReport, ElementOutcomeRecord, ErrorRecord, Finding } from "../model/index.js";

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const EMAIL_PATTERN = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Match phone numbers while avoiding IPv4 addresses (e.g. 127.0.0.1)
const PHONE_PATTERN = /\b(?!\d{1,3}(?:\.\d{1,3}){3}\b)(?:\+\d[\d\s()-]{7,}\d|\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}|\d{3}[\s-]\d{3}[\s-]\d{4}|\d{10,15})\b/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KV_SECRET_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?token|cookie|set-cookie|authorization)\s*([:=])\s*([^\s,;]+)/gi;
const PREFIXED_TOKEN_PATTERN = /\b(sk_live|sk_test|pk_live|pk_test|ghp|gho|ghu|xoxb|xoxp)_[A-Za-z0-9]{10,}\b/g;
const QUERY_STRING_PATTERN = /(\bhttps?:\/\/[^\s?#]+)\?[^\s#]+/gi;

/**
 * Redacts sensitive tokens, credentials, PII, and query strings from free text
 * before persistence in logs, findings, or reports.
 */
export function redactText(input: string): string {
  return input
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(BEARER_PATTERN, "$1 [REDACTED_TOKEN]")
    .replace(PREFIXED_TOKEN_PATTERN, "[REDACTED_API_KEY]")
    .replace(KV_SECRET_PATTERN, "$1$2[REDACTED]")
    .replace(QUERY_STRING_PATTERN, "$1?[REDACTED]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(PHONE_PATTERN, "[REDACTED_PHONE]");
}

/**
 * Returns a redacted copy of an ErrorRecord.
 */
export function redactErrorRecord(record: ErrorRecord): ErrorRecord {
  return {
    ...record,
    message: redactText(record.message),
    ...(record.origin !== undefined ? { origin: redactText(record.origin) } : {}),
  };
}

function redactOutcomeRecord(record: ElementOutcomeRecord): ElementOutcomeRecord {
  return {
    ...record,
    name: redactText(record.name),
    context: redactText(record.context),
    ...(record.reason !== undefined ? { reason: redactText(record.reason) } : {}),
    observation: {
      ...record.observation,
      attributedErrors: record.observation.attributedErrors.map(redactErrorRecord),
      signals: record.observation.signals.map((sig) => ({
        ...sig,
        detail: redactText(sig.detail),
        ...(sig.origin !== undefined ? { origin: redactText(sig.origin) } : {}),
        ...(sig.error !== undefined ? { error: redactErrorRecord(sig.error) } : {}),
      })),
      ...(record.observation.reason !== undefined
        ? { reason: redactText(record.observation.reason) }
        : {}),
    },
  };
}

function redactFinding(finding: Finding): Finding {
  return {
    ...finding,
    elementName: redactText(finding.elementName),
    errorSummary: redactText(finding.errorSummary),
    reproductionPath: finding.reproductionPath.map(redactText),
    signature: {
      ...finding.signature,
      pageContext: redactText(finding.signature.pageContext),
      normalizedErrorMessage: redactText(finding.signature.normalizedErrorMessage),
      interactionContext: redactText(finding.signature.interactionContext),
    },
  };
}

/**
 * Redacts all untrusted and potentially sensitive fields across a CrawlReport.
 */
export function redactCrawlReport(report: CrawlReport): CrawlReport {
  return {
    ...report,
    targetEntryPoint: redactText(report.targetEntryPoint),
    elementOutcomes: report.elementOutcomes.map(redactOutcomeRecord),
    findings: report.findings.map(redactFinding),
    attributedErrors: report.attributedErrors.map(redactErrorRecord),
  };
}
