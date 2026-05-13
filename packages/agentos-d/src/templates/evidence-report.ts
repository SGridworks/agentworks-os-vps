/**
 * Compliance Evidence Report — HTML template.
 *
 * Pure rendering functions: input is data, output is an HTML string. No DB
 * access. Routes / cron jobs aggregate the data, then call into here to get
 * an HTML doc that PdfEngine can render.
 *
 * Sections covered (corresponding tickets):
 *   - Header: report ID, tenant, period, generated-at (AWO-79 footer is in
 *     evidence-footer.ts; this header anchors the doc)
 *   - Decision summary: total / allowed / blocked / reviewed (AWO-83 base)
 *   - Policy violations prevented: count + categories (AWO-76)
 *   - Configs scanned + findings summary: per-severity counts + worst N
 *     (AWO-78)
 *   - Spend attributed: placeholder for cost meter v1.1 (AWO-77)
 */

export interface DecisionSummary {
  totalDecisions: number;
  allowed: number;
  blocked: number;
  reviewed: number;
}

export interface ViolationCategory {
  /** Stable label for the category — usually the rule pack id. */
  rulePackId: string;
  /** Human-readable label. */
  label: string;
  /** Count of `block` or `route_to_review` decisions in this category. */
  count: number;
}

export interface FindingsCategory {
  severity: "critical" | "high" | "medium" | "low" | "info";
  count: number;
}

export interface FindingHighlight {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  affectedEndpoint: string | null;
  status: "open" | "resolved";
  ruleId: string | null;
}

export interface EvidenceReportData {
  reportId: string;
  tenantId: string;
  tenantLabel?: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  summary: DecisionSummary;
  violations: ViolationCategory[];
  findingsBySeverity: FindingsCategory[];
  findingsHighlights: FindingHighlight[];
  /** When set, renders inline; otherwise rendered into the spend placeholder. */
  spendNotice?: string;
}

const SEVERITY_ORDER: Record<FindingsCategory["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const SEVERITY_LABEL: Record<FindingsCategory["severity"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(input: string | null | undefined): string {
  if (input == null) return "";
  return String(input).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c);
}

function fmtPct(numerator: number, denominator: number): string {
  if (denominator === 0) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

// ---------------------------------------------------------------------------
// AWO-76 — Policy violations prevented (count + categories)
// ---------------------------------------------------------------------------

export function renderViolationsSection(violations: ViolationCategory[]): string {
  const sorted = [...violations].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((s, v) => s + v.count, 0);

  if (total === 0) {
    return [
      `<section class="violations">`,
      `  <h2>Policy Violations Prevented</h2>`,
      `  <p class="empty">No policy violations were blocked or routed for review during this period.</p>`,
      `</section>`,
    ].join("\n");
  }

  const rows = sorted
    .map(
      (v) => `
    <tr>
      <td>${escapeHtml(v.label)}</td>
      <td class="muted">${escapeHtml(v.rulePackId)}</td>
      <td class="num">${v.count}</td>
      <td class="num muted">${fmtPct(v.count, total)}</td>
    </tr>`,
    )
    .join("");

  return [
    `<section class="violations">`,
    `  <h2>Policy Violations Prevented</h2>`,
    `  <p class="lede"><strong>${total}</strong> action${total === 1 ? "" : "s"} blocked or routed for human review across <strong>${sorted.length}</strong> categor${sorted.length === 1 ? "y" : "ies"}.</p>`,
    `  <table class="categories">`,
    `    <thead><tr><th>Category</th><th>Rule Pack</th><th class="num">Count</th><th class="num">Share</th></tr></thead>`,
    `    <tbody>${rows}</tbody>`,
    `  </table>`,
    `</section>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// AWO-78 — Configs scanned + findings summary
// ---------------------------------------------------------------------------

export function renderConfigsScannedSection(
  findingsBySeverity: FindingsCategory[],
  highlights: FindingHighlight[] = [],
  configsScanned: number = 0,
): string {
  const ordered = [...findingsBySeverity].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const total = ordered.reduce((s, f) => s + f.count, 0);
  const open = highlights.filter((h) => h.status === "open").length;
  const resolved = highlights.length - open;

  const sevRows = ordered
    .map(
      (f) => `
    <tr class="sev-${f.severity}">
      <td>${SEVERITY_LABEL[f.severity]}</td>
      <td class="num">${f.count}</td>
    </tr>`,
    )
    .join("");

  const highlightRows = highlights.length
    ? highlights
        .map(
          (h) => `
      <tr class="sev-${h.severity}">
        <td><span class="badge badge-${h.severity}">${SEVERITY_LABEL[h.severity]}</span></td>
        <td>${escapeHtml(h.title)}</td>
        <td class="muted">${escapeHtml(h.ruleId ?? "—")}</td>
        <td class="muted mono">${escapeHtml(h.affectedEndpoint ?? "—")}</td>
        <td>${h.status === "resolved" ? '<span class="resolved">Resolved</span>' : '<span class="open">Open</span>'}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No findings to highlight.</td></tr>`;

  return [
    `<section class="configs-scanned">`,
    `  <h2>Configs Scanned &amp; Findings</h2>`,
    `  <p class="lede"><strong>${configsScanned}</strong> agent config${configsScanned === 1 ? "" : "s"} scanned this period. <strong>${total}</strong> finding${total === 1 ? "" : "s"} surfaced — <strong>${open}</strong> open, <strong>${resolved}</strong> resolved.</p>`,
    `  <h3>By severity</h3>`,
    `  <table class="severity-counts">`,
    `    <thead><tr><th>Severity</th><th class="num">Count</th></tr></thead>`,
    `    <tbody>${sevRows || `<tr><td colspan="2" class="empty">No findings.</td></tr>`}</tbody>`,
    `  </table>`,
    `  <h3>Top findings</h3>`,
    `  <table class="findings-highlights">`,
    `    <thead><tr><th>Severity</th><th>Title</th><th>Rule</th><th>Affected</th><th>Status</th></tr></thead>`,
    `    <tbody>${highlightRows}</tbody>`,
    `  </table>`,
    `</section>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// AWO-77 — Spend attributed (placeholder for cost meter v1.1)
// ---------------------------------------------------------------------------

export function renderSpendSection(notice?: string): string {
  const body =
    notice ??
    "Spend attribution will be available in cost meter v1.1. " +
      "This release reports compliance posture only; spend by tenant, agent, " +
      "and employee will appear here once cost-meter is shipped.";

  return [
    `<section class="spend">`,
    `  <h2>Spend Attributed</h2>`,
    `  <p class="placeholder"><em>${escapeHtml(body)}</em></p>`,
    `</section>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Document skeleton
// ---------------------------------------------------------------------------

const REPORT_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; font-size: 11pt; line-height: 1.4; }
  h1 { font-size: 22pt; margin: 0 0 4pt 0; }
  h2 { font-size: 14pt; margin: 18pt 0 6pt 0; border-bottom: 1px solid #ddd; padding-bottom: 2pt; }
  h3 { font-size: 11pt; margin: 12pt 0 4pt 0; color: #444; }
  table { width: 100%; border-collapse: collapse; margin: 6pt 0; }
  th, td { padding: 4pt 6pt; border-bottom: 1px solid #eee; text-align: left; }
  th { font-weight: 600; background: #f5f5f5; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #777; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 9pt; }
  .empty { color: #999; font-style: italic; }
  .lede { color: #333; }
  .placeholder { color: #888; }
  .badge { display: inline-block; padding: 1pt 6pt; border-radius: 3pt; font-size: 8pt; color: #fff; }
  .badge-critical { background: #b1001b; }
  .badge-high { background: #d04a02; }
  .badge-medium { background: #b87600; }
  .badge-low { background: #2c6e49; }
  .badge-info { background: #5b6770; }
  .resolved { color: #2c6e49; font-weight: 600; }
  .open { color: #b1001b; font-weight: 600; }
  .meta { color: #666; font-size: 9pt; margin: 2pt 0; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt; margin: 8pt 0; }
  .summary-card { border: 1px solid #ddd; border-radius: 4pt; padding: 8pt; }
  .summary-card .num { font-size: 18pt; font-weight: 600; }
  .summary-card .label { color: #666; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .disclaimer { background: #f5f5f5; border-left: 3px solid #999; padding: 8pt 10pt; margin: 10pt 0; font-size: 9pt; color: #555; }
  .disclaimer strong { color: #333; }
`;

function renderHeader(data: EvidenceReportData): string {
  const tenantTitle = data.tenantLabel
    ? `${escapeHtml(data.tenantLabel)} <span class="muted">(${escapeHtml(data.tenantId)})</span>`
    : escapeHtml(data.tenantId);
  return [
    `<header>`,
    `  <h1>Compliance Evidence Report</h1>`,
    `  <p class="meta">Tenant: ${tenantTitle}</p>`,
    `  <p class="meta">Period: ${escapeHtml(data.periodStart)} → ${escapeHtml(data.periodEnd)}</p>`,
    `  <p class="meta">Report ID: <span class="mono">${escapeHtml(data.reportId)}</span></p>`,
    `  <p class="meta">Generated: ${escapeHtml(data.generatedAt)}</p>`,
    `</header>`,
  ].join("\n");
}

function renderDisclaimer(): string {
  return [
    `<p class="disclaimer">`,
    `  <strong>Disclaimer:</strong> This report documents system state and decisions logged by AgentWorks OS. `,
    `It is not an attestation of legal compliance and does not constitute legal advice.`,
    `</p>`,
  ].join("\n");
}

function renderSummarySection(s: DecisionSummary): string {
  return [
    `<section class="summary">`,
    `  <h2>Decision Summary</h2>`,
    `  <div class="summary-grid">`,
    `    <div class="summary-card"><div class="num">${s.totalDecisions}</div><div class="label">Total</div></div>`,
    `    <div class="summary-card"><div class="num">${s.allowed}</div><div class="label">Allowed</div></div>`,
    `    <div class="summary-card"><div class="num">${s.blocked}</div><div class="label">Blocked</div></div>`,
    `    <div class="summary-card"><div class="num">${s.reviewed}</div><div class="label">Reviewed</div></div>`,
    `  </div>`,
    `</section>`,
  ].join("\n");
}

export function renderEvidenceReportHtml(
  data: EvidenceReportData,
  configsScanned: number = 0,
): string {
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="utf-8" />`,
    `  <title>AgentWorks Evidence Report ${escapeHtml(data.reportId)}</title>`,
    `  <style>${REPORT_STYLES}</style>`,
    `</head>`,
    `<body>`,
    renderHeader(data),
    renderDisclaimer(),
    renderSummarySection(data.summary),
    renderViolationsSection(data.violations),
    renderConfigsScannedSection(data.findingsBySeverity, data.findingsHighlights, configsScanned),
    renderSpendSection(data.spendNotice),
    `</body>`,
    `</html>`,
  ].join("\n");
}
