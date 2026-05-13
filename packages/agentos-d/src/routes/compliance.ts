/**
 * Compliance evidence report routes.
 *
 *   GET /api/compliance/evidence-report?tenant_id=...&from=...&to=...
 *
 * Aggregates policy_decisions for a tenant inside [from, to) and renders a
 * PDF evidence report using the configured PdfEngine.
 *
 * Query params (snake_case per task spec):
 *   tenant_id  — UUID of the tenant
 *   from       — ISO 8601 datetime or date-only (e.g. 2026-01-01); inclusive
 *   to         — ISO 8601 datetime or date-only (e.g. 2026-12-31); exclusive
 *
 * Response: application/pdf with Content-Disposition: attachment.
 */

import { Router } from "express";
import { z } from "zod";
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { policyDecisions } from "../db/schema.js";
import { verifyHashChain } from "../verification/hash-chain.js";
import {
  aggregateEvidenceReportData,
} from "../services/evidence-report.js";
import { renderEvidenceReportHtml } from "../templates/evidence-report.js";
import type { Config } from "../config.js";
import type { PdfEngine } from "@agentworks/pdf";

const QuerySchema = z.object({
  tenant_id: z.string().uuid(),
  from: z.string().min(1),
  to: z.string().min(1),
});

/** Returns the PdfEngine from daemon config, throwing if not initialised. */
function requirePdfEngine(config: Config): PdfEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = (config as any).pdfEngine as PdfEngine | undefined;
  if (!engine) {
    throw new Error(
      "PdfEngine not configured on this daemon. Set pdfEngine in daemon config or DAEMON_PDF_ENGINE env var.",
    );
  }
  return engine;
}

export function createComplianceRouter(config: Config): Router {
  const router = Router();

  router.get("/evidence-report", (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const { tenant_id: tenantId, from: periodStart, to: periodEnd } = parsed.data;

    // Normalise date-only strings to full ISO datetimes for SQL range queries.
    // If the string already contains a time component, leave it as-is.
    const toIsoDate = (s: string): string =>
      s.includes("T") ? s : `${s}T00:00:00Z`;
    const isoStart = toIsoDate(periodStart);
    const isoEnd = toIsoDate(periodEnd);

    if (isoStart >= isoEnd) {
      res
        .status(400)
        .json({ error: "invalid_period", message: "from must be before to" });
      return;
    }

    let engine: PdfEngine;
    try {
      engine = requirePdfEngine(config);
    } catch (err) {
      res
        .status(500)
        .json({ error: "pdf_engine_unavailable", message: (err as Error).message });
      return;
    }

    const now = new Date().toISOString();
    const generatedAt = now;

    // Aggregate the report data from the DB.
    const reportData = aggregateEvidenceReportData({
      tenantId,
      periodStart: isoStart,
      periodEnd: isoEnd,
      generatedAt,
    });

    // Render the HTML and convert to PDF via the configured engine.
    const html = renderEvidenceReportHtml(reportData, reportData.findingsHighlights.length);

    engine
      .render(html, { timeoutMs: 60_000 })
      .then((rendered) => {
        const filename = `evidence-report-${tenantId}-${periodStart}-${periodEnd}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.setHeader("Content-Length", rendered.byteLength);
        res.status(200).send(Buffer.from(rendered.bytes));
      })
      .catch((err: unknown) => {
        console.error("PDF rendering failed:", err);
        res.status(500).json({
          error: "pdf_rendering_failed",
          message: (err as Error).message,
        });
      });
  });

  // -------------------------------------------------------------------------
  // GET /api/compliance/verify-chain?tenantId=...
  //
  // Walks every policy_decisions row for the tenant in createdAt order,
  // recomputes decision_hash from stored evidence/decision/reason, and
  // verifies prev_decision_hash linkage. Returns:
  //   { tenantId, rowsChecked, ok, breaks: [{rowId, reason, expected, actual}] }
  // Status is always 200 — `ok=false` is the operator signal, not a 4xx.
  // -------------------------------------------------------------------------
  const VerifyQuerySchema = z.object({ tenantId: z.string().uuid() });

  router.get("/verify-chain", (req, res) => {
    const parsed = VerifyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const result = verifyHashChain(parsed.data.tenantId);
    res.json(result);
  });

  return router;
}
