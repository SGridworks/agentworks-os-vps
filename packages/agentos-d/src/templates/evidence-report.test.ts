/**
 * evidence-report template tests.
 *
 *   - escapeHtml prevents script injection from rule labels and finding titles
 *   - renderViolationsSection: empty state, sorted by count desc, % share rounds
 *   - renderConfigsScannedSection: severity ordering, highlight rendering,
 *     resolved/open status, empty state
 *   - renderSpendSection: default placeholder, custom notice
 *   - renderEvidenceReportHtml: doctype + title + every section composed
 */

import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  renderViolationsSection,
  renderConfigsScannedSection,
  renderSpendSection,
  renderEvidenceReportHtml,
  type EvidenceReportData,
  type FindingHighlight,
} from "./evidence-report.js";

describe("escapeHtml", () => {
  it("escapes the OWASP Big 5", () => {
    expect(escapeHtml(`<script>alert('x' & "y")</script>`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39; &amp; &quot;y&quot;)&lt;/script&gt;",
    );
  });

  it("returns empty string for null / undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("leaves benign text untouched", () => {
    expect(escapeHtml("normal text 123")).toBe("normal text 123");
  });
});

describe("renderViolationsSection (AWO-76)", () => {
  it("shows empty state when no violations", () => {
    const html = renderViolationsSection([]);
    expect(html).toContain("Policy Violations Prevented");
    expect(html).toContain("No policy violations");
  });

  it("sorts categories by count descending", () => {
    const html = renderViolationsSection([
      { rulePackId: "tcpa-real-estate", label: "TCPA", count: 3 },
      { rulePackId: "fair-housing", label: "Fair Housing", count: 12 },
      { rulePackId: "smb-starter", label: "SMB Baseline", count: 7 },
    ]);
    const fhPos = html.indexOf("Fair Housing");
    const smbPos = html.indexOf("SMB Baseline");
    const tcpaPos = html.indexOf("TCPA");
    expect(fhPos).toBeLessThan(smbPos);
    expect(smbPos).toBeLessThan(tcpaPos);
  });

  it("computes percentage share with proper rounding", () => {
    const html = renderViolationsSection([
      { rulePackId: "p1", label: "A", count: 1 },
      { rulePackId: "p2", label: "B", count: 2 },
    ]);
    expect(html).toContain("33%");
    expect(html).toContain("67%");
  });

  it("escapes user-controlled labels", () => {
    const html = renderViolationsSection([
      { rulePackId: "p", label: "<img src=x onerror=alert(1)>", count: 1 },
    ]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("includes total in lede", () => {
    const html = renderViolationsSection([
      { rulePackId: "a", label: "A", count: 5 },
      { rulePackId: "b", label: "B", count: 7 },
    ]);
    expect(html).toContain("<strong>12</strong>");
  });
});

describe("renderConfigsScannedSection (AWO-78)", () => {
  it("shows severity counts in canonical order", () => {
    const html = renderConfigsScannedSection([
      { severity: "low", count: 5 },
      { severity: "critical", count: 1 },
      { severity: "medium", count: 3 },
    ]);
    const critPos = html.indexOf("Critical");
    const medPos = html.indexOf("Medium");
    const lowPos = html.indexOf("Low");
    expect(critPos).toBeLessThan(medPos);
    expect(medPos).toBeLessThan(lowPos);
  });

  it("renders highlights with severity badges and status", () => {
    const highlights: FindingHighlight[] = [
      {
        id: "f1",
        severity: "critical",
        title: "Hardcoded API key in MCP config",
        affectedEndpoint: "/etc/mcp.json",
        status: "open",
        ruleId: "MCP-001",
      },
      {
        id: "f2",
        severity: "medium",
        title: "Short CLAUDE.md lacks identity",
        affectedEndpoint: "/proj/CLAUDE.md",
        status: "resolved",
        ruleId: "MD-JAILBREAK-001",
      },
    ];
    const html = renderConfigsScannedSection([], highlights);
    expect(html).toContain('class="badge badge-critical"');
    expect(html).toContain('class="badge badge-medium"');
    expect(html).toContain("Hardcoded API key in MCP config");
    expect(html).toContain("MCP-001");
    expect(html).toContain("/etc/mcp.json");
    expect(html).toContain('<span class="open">Open</span>');
    expect(html).toContain('<span class="resolved">Resolved</span>');
  });

  it("counts open vs resolved highlights in the lede", () => {
    const highlights: FindingHighlight[] = [
      { id: "1", severity: "high", title: "x", affectedEndpoint: null, status: "open", ruleId: null },
      { id: "2", severity: "high", title: "y", affectedEndpoint: null, status: "open", ruleId: null },
      { id: "3", severity: "low", title: "z", affectedEndpoint: null, status: "resolved", ruleId: null },
    ];
    const html = renderConfigsScannedSection(
      [{ severity: "high", count: 2 }, { severity: "low", count: 1 }],
      highlights,
      4,
    );
    expect(html).toContain("<strong>4</strong> agent config");
    expect(html).toContain("<strong>3</strong> finding");
    expect(html).toContain("<strong>2</strong> open");
    expect(html).toContain("<strong>1</strong> resolved");
  });

  it("renders empty state when no findings or highlights", () => {
    const html = renderConfigsScannedSection([], [], 0);
    expect(html).toContain("0</strong> agent config");
    expect(html).toContain("No findings.");
    expect(html).toContain("No findings to highlight.");
  });

  it("escapes finding titles and affected paths", () => {
    const html = renderConfigsScannedSection(
      [],
      [
        {
          id: "x",
          severity: "high",
          title: "<svg onload=alert(1)>",
          affectedEndpoint: "<a>",
          status: "open",
          ruleId: null,
        },
      ],
    );
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;svg onload");
    expect(html).toContain("&lt;a&gt;");
  });

  it("uses singular vs plural correctly", () => {
    const single = renderConfigsScannedSection(
      [{ severity: "low", count: 1 }],
      [{ id: "1", severity: "low", title: "x", affectedEndpoint: null, status: "open", ruleId: null }],
      1,
    );
    expect(single).toContain("<strong>1</strong> agent config scanned");
    expect(single).toContain("<strong>1</strong> finding surfaced");

    const multi = renderConfigsScannedSection(
      [{ severity: "low", count: 3 }],
      [
        { id: "1", severity: "low", title: "x", affectedEndpoint: null, status: "open", ruleId: null },
        { id: "2", severity: "low", title: "y", affectedEndpoint: null, status: "open", ruleId: null },
        { id: "3", severity: "low", title: "z", affectedEndpoint: null, status: "open", ruleId: null },
      ],
      2,
    );
    expect(multi).toContain("<strong>2</strong> agent configs scanned");
    expect(multi).toContain("<strong>3</strong> findings surfaced");
  });
});

describe("renderSpendSection (AWO-77)", () => {
  it("renders the cost-meter v1.1 placeholder by default", () => {
    const html = renderSpendSection();
    expect(html).toContain("Spend Attributed");
    expect(html).toContain("cost meter v1.1");
  });

  it("uses a custom notice when provided", () => {
    const html = renderSpendSection("Spend dashboard is in beta — see admin UI.");
    expect(html).toContain("Spend dashboard is in beta");
    expect(html).not.toContain("cost meter v1.1");
  });

  it("escapes HTML in the custom notice", () => {
    const html = renderSpendSection("<script>x</script>");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderEvidenceReportHtml (AWO-78 composite)", () => {
  function makeData(overrides: Partial<EvidenceReportData> = {}): EvidenceReportData {
    return {
      reportId: "rep-1",
      tenantId: "t-1",
      tenantLabel: "Example Tenant",
      periodStart: "2026-04-01T00:00:00Z",
      periodEnd: "2026-05-01T00:00:00Z",
      generatedAt: "2026-04-28T00:00:00Z",
      summary: { totalDecisions: 100, allowed: 80, blocked: 15, reviewed: 5 },
      violations: [{ rulePackId: "tcpa-real-estate", label: "TCPA", count: 8 }],
      findingsBySeverity: [{ severity: "medium", count: 3 }],
      findingsHighlights: [
        {
          id: "f1",
          severity: "medium",
          title: "Short CLAUDE.md",
          affectedEndpoint: "/CLAUDE.md",
          status: "open",
          ruleId: "MD-JAILBREAK-001",
        },
      ],
      ...overrides,
    };
  }

  it("emits a complete HTML document", () => {
    const html = renderEvidenceReportHtml(makeData());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>AgentWorks Evidence Report rep-1</title>");
    expect(html.endsWith("</html>")).toBe(true);
  });

  it("composes all four sections in order", () => {
    const html = renderEvidenceReportHtml(makeData(), 7);
    const summaryPos = html.indexOf("Decision Summary");
    const violationsPos = html.indexOf("Policy Violations Prevented");
    const configsPos = html.indexOf("Configs Scanned");
    const spendPos = html.indexOf("Spend Attributed");
    expect(summaryPos).toBeGreaterThan(0);
    expect(violationsPos).toBeGreaterThan(summaryPos);
    expect(configsPos).toBeGreaterThan(violationsPos);
    expect(spendPos).toBeGreaterThan(configsPos);
  });

  it("renders tenant label and id in header", () => {
    const html = renderEvidenceReportHtml(makeData());
    expect(html).toContain("Example Tenant");
    expect(html).toContain("t-1");
  });

  it("falls back to tenantId when tenantLabel is absent", () => {
    const html = renderEvidenceReportHtml(makeData({ tenantLabel: undefined }));
    expect(html).toContain("t-1");
    expect(html).not.toContain("Example Tenant");
  });

  it("inlines styles so the HTML is self-contained for PDF rendering", () => {
    const html = renderEvidenceReportHtml(makeData());
    expect(html).toContain("<style>");
    expect(html).toContain("badge-critical");
    expect(html).toContain("summary-grid");
  });

  it("forwards configsScanned into the configs section lede", () => {
    const html = renderEvidenceReportHtml(makeData(), 12);
    expect(html).toContain("<strong>12</strong> agent configs scanned");
  });

  it("renders summary card numbers", () => {
    const html = renderEvidenceReportHtml(makeData());
    expect(html).toContain('class="num">100</div><div class="label">Total');
    expect(html).toContain('class="num">80</div><div class="label">Allowed');
    expect(html).toContain('class="num">15</div><div class="label">Blocked');
    expect(html).toContain('class="num">5</div><div class="label">Reviewed');
  });
});
