/**
 * Scanner routes: submit scans to the scanner-worker sidecar and persist findings.
 * Implements the RFC 003 HTTP API contract between agentos-d and scanner-worker.
 *
 * POST   /api/scanner/submit - submit a scan request to scanner-worker (RFC 003)
 * GET    /api/scanner/jobs/:id - poll scan result from scanner-worker (RFC 003)
 * POST   /api/scanner/jobs/:id/cancel - cancel a running scan (RFC 003)
 * GET    /api/scanner/findings - list persisted scanner findings
 * PATCH  /api/scanner/findings/:id - update finding status (resolve/reopen)
 */

import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { scannerFindings } from "../db/schema.js";
import { eq, desc, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";

type Severity = "critical" | "high" | "medium" | "low" | "info";

export function createScannerRouter(config: Config): Router {
  const router = Router();

  // RFC 003 § Base URL: scanner-worker runs on port 3101 internally
  const SCANNER_WORKER_BASE = config.scannerSidecarUrl ?? "http://127.0.0.1:3101";

  // -------------------------------------------------------------------------
  // Schemas for the RFC 003 wire format.
  // -------------------------------------------------------------------------

  /**
   * RFC 003 § POST /scan request body.
   * agentos-d accepts either legacy fields (targetUrl, pasteContent) OR
   * the full RFC 003 target object. Legacy fields are adapted to RFC 003
   * format before forwarding to scanner-worker.
   */
  const SubmitScanSchema = z
    .object({
      tenantId: z.string().uuid(),
      // Legacy agentos-d fields (backward compat)
      targetUrl: z.string().url().optional(),
      pasteContent: z.string().max(50000).optional(),
      // RFC 003 native fields
      target: z
        .object({
          type: z.enum(["claude_md", "cursorrules", "mcp_config", "n8n_workflow"]),
          path: z.string(),
          content: z.string(),
        })
        .optional(),
      policyMode: z.enum(["shadow", "enforce"]).default("shadow"),
      priority: z.enum(["standard", "high"]).default("standard"),
      // Legacy extras are passed as-is for scanner-worker compat.
      agentName: z.string().optional(),
      checks: z.array(z.string()).optional(),
    })
    .refine(
      (data) => data.target || data.targetUrl || data.pasteContent,
      { message: "target object or targetUrl or pasteContent is required" }
    );

  const UpdateFindingSchema = z.object({
    status: z.enum(["open", "resolved"]).optional(),
    resolvedBy: z.string().optional(),
    resolutionNote: z.string().optional(),
  });

  const SubmitFindingSchema = z.object({
    tenantId: z.string().uuid(),
    severity: z.enum(["critical", "high", "medium", "low", "info"]).default("info"),
    ruleId: z.string().max(180).optional(),
    title: z.string().min(1).max(240),
    description: z.string().max(4000).default(""),
    remediation: z.string().max(4000).optional(),
    affectedEndpoint: z.string().max(500).optional(),
    originId: z.string().max(180).optional(),
  });

  // -------------------------------------------------------------------------
  // GET /api/scanner/health, RFC 003 § GET /health
  // Proxies the scanner-worker liveness probe. Returns 200 when the sidecar is
  // healthy, 503 when it is not.
  // -------------------------------------------------------------------------

  router.get("/health", async (req, res) => {
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${SCANNER_WORKER_BASE}/health`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      res.status(503).json({ status: "unhealthy", reason: "scanner_worker_unreachable" });
      return;
    }

    if (!upstreamRes.ok) {
      const body = (await upstreamRes.json().catch(() => ({}))) as Record<string, any>;
      res.status(503).json({ status: "unhealthy", reason: body.reason ?? "scanner_reported_unhealthy" });
      return;
    }

    const body = (await upstreamRes.json()) as Record<string, any>;
    res.json({
      status: "healthy",
      scannerVersion: body.scannerVersion,
      definitionsLoaded: body.definitionsLoaded,
      definitionsCount: body.definitionsCount,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/scanner/batch, RFC 003 § POST /scan/batch
  // Submit multiple targets in one request (nightly full-scan).
  // -------------------------------------------------------------------------

  const BatchSubmitSchema = z.object({
    tenantId: z.string().uuid(),
    batchId: z.string().optional(), // client may provide; generate if absent
    targets: z
      .array(
        z.object({
          type: z.enum(["claude_md", "cursorrules", "mcp_config", "n8n_workflow"]),
          path: z.string(),
          content: z.string(),
        })
      )
      .min(1),
    policyMode: z.enum(["shadow", "enforce"]).default("shadow"),
    priority: z.enum(["standard", "high"]).default("standard"),
  });

  router.post("/batch", async (req, res) => {
    const parsed = BatchSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;
    const batchId = body.batchId ?? randomUUID();

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${SCANNER_WORKER_BASE}/scan/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: body.tenantId,
          batchId,
          targets: body.targets,
          policyMode: body.policyMode,
          priority: body.priority,
        }),
        signal: AbortSignal.timeout(120_000), // batch scans can take longer
      });
    } catch (err) {
      res.status(502).json({ error: "scanner_worker_unreachable", message: String(err) });
      return;
    }

    if (upstreamRes.status === 404) {
      // scanner-worker may not implement batch yet, so return 501.
      res.status(501).json({ error: "batch_not_implemented" });
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      res.status(502).json({ error: "scanner_worker_error", status: upstreamRes.status, body: text });
      return;
    }

    const result = (await upstreamRes.json()) as Record<string, any>;
    // Normalize snake_case from scanner-worker → camelCase for agentos-d consumers
    res.status(upstreamRes.status).json({
      batchId: result.batch_id ?? batchId,
      status: result.status,
      targetCount: result.targetCount ?? body.targets.length,
      estimatedSeconds: result.estimatedSeconds,
      results: result.results,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/scanner/submit
  // Adapts legacy/internal format → RFC 003 before forwarding to scanner-worker.
  // -------------------------------------------------------------------------

  router.post("/submit", async (req, res) => {
    const parsed = SubmitScanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;

    // Build the RFC 003 request body for scanner-worker.
    // scanner-worker expects: { tenantId, scanId, target: {type, path, content}, policyMode, priority }
    let scanId: string;
    let target: { type: string; path: string; content: string };
    let policyMode: string;
    let priority: string;

    if (body.target) {
      // Native RFC 003 format
      scanId = randomUUID();
      target = {
        type: body.target.type,
        path: body.target.path,
        content: body.target.content,
      };
      policyMode = body.policyMode;
      priority = body.priority;
    } else {
      // Legacy format adapted to RFC 003 target object.
      scanId = randomUUID();
      if (body.targetUrl) {
        target = {
          type: "claude_md",
          path: body.targetUrl,
          content: "",
        };
      } else {
        // pasteContent always present here due to .refine() guard
        target = {
          type: "claude_md",
          path: "paste",
          content: body.pasteContent!,
        };
      }
      policyMode = body.policyMode;
      priority = body.priority;
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${SCANNER_WORKER_BASE}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: body.tenantId,
          scanId,
          target,
          policyMode,
          priority,
        }),
        signal: AbortSignal.timeout(30000), // RFC 003: 60s timeout per target
      });
    } catch (err) {
      res.status(502).json({ error: "scanner_worker_unreachable", message: String(err) });
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      let errorCode = "scanner_worker_error";
      if (upstreamRes.status === 400) errorCode = "invalid_target_type";
      if (upstreamRes.status === 503) errorCode = "scanner_unavailable";
      res.status(502).json({
        error: errorCode,
        status: upstreamRes.status,
        body: text,
      });
      return;
    }

    const scanResult = (await upstreamRes.json()) as Record<string, any>;
    // RFC 003: scanResult may have status "complete", "queued", or "error"
    res.status(202).json({
      scanId: scanResult.scan_id ?? scanId,
      status: scanResult.status,
      submittedAt: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/scanner/jobs/:id, RFC 003 § GET /scan/{scanId}
  // tenantId must be passed as query param since scanner-worker does not echo it.
  // -------------------------------------------------------------------------

  router.get("/jobs/:id", async (req, res) => {
    const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : "unknown";
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${SCANNER_WORKER_BASE}/scan/${req.params.id}`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      res.status(502).json({ error: "scanner_worker_unreachable", message: String(err) });
      return;
    }

    if (upstreamRes.status === 404) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      res.status(502).json({ error: "scanner_worker_error", status: upstreamRes.status, body: text });
      return;
    }

    // scanner-worker returns RFC 003 format:
    // { scan_id: string, status: "complete"|"error"|"running", findings: [...], scanned_at: ISO8601 }
    // Note: scan_id is snake_case in the JSON (Pydantic serialize), findings are camelCase
    const scanResult = (await upstreamRes.json()) as {
      scan_id: string;
      status: string;
      findings?: Array<Record<string, any>>;
      scanned_at: string;
    };

    // Persist findings if complete. RFC 003 says "complete", not "completed".
    if (scanResult.status === "complete" && Array.isArray(scanResult.findings)) {
      const db = getDb();
      const now = new Date().toISOString();

      // Insert finding with idempotency – avoid duplicate persisted findings
    for (const finding of scanResult.findings) {
      const findingId = randomUUID();
      // Check for existing finding with same tenantId, originId, and affectedEndpoint
      const existing = db
        .select()
        .from(scannerFindings)
        .where(
          and(
            eq(scannerFindings.tenantId, tenantId),
            eq(scannerFindings.originId, finding.id ?? finding.rule_id ?? findingId),
            eq(scannerFindings.affectedEndpoint, finding.location?.file ?? null)
          )
        )
        .get();
      if (existing) continue;
      db.insert(scannerFindings).values({
        id: findingId,
        tenantId: tenantId,
        originId: finding.id ?? finding.rule_id ?? findingId,
        originKind: "scanner_finding",
        severity: (finding.severity?.toLowerCase() ?? "info") as Severity,
        ruleId: finding.rule_id ?? null,
        title: finding.title ?? "Untitled finding",
        description: finding.description ?? "",
        remediation: finding.remediation ?? null,
        affectedEndpoint: finding.location?.file ?? null,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    }

    // Forward the raw scanner-worker response; map scan_id to scanId for caller compat
    res.json({
      scanId: scanResult.scan_id,
      status: scanResult.status,
      findings: scanResult.findings ?? [],
      scannedAt: scanResult.scanned_at,
    });
  });

  router.post("/jobs/:id/cancel", async (req, res) => {
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${SCANNER_WORKER_BASE}/scan/${req.params.id}/cancel`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      res.status(502).json({ error: "scanner_worker_unreachable", message: String(err) });
      return;
    }

    if (upstreamRes.status === 404) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      res.status(502).json({ error: "scanner_worker_error", status: upstreamRes.status, body: text });
      return;
    }

    const result = await upstreamRes.json();
    res.json(result);
  });

  // -------------------------------------------------------------------------
  // GET /api/scanner/jobs/:id/sarif, RFC 003 § GET /scan/{scanId}/sarif
  // Returns SARIF 2.1.0 representation of all findings for the job.
  // -------------------------------------------------------------------------

  router.get("/jobs/:id/sarif", async (req, res) => {
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${SCANNER_WORKER_BASE}/scan/${req.params.id}/sarif`, {
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      res.status(502).json({ error: "scanner_worker_unreachable", message: String(err) });
      return;
    }

    if (upstreamRes.status === 404) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (upstreamRes.status === 503) {
      res.status(503).json({ error: "scanner_unavailable" });
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      res.status(502).json({ error: "scanner_worker_error", status: upstreamRes.status, body: text });
      return;
    }

    // scanner-worker returns SARIF 2.1.0 with Content-Type: application/json
    const body = await upstreamRes.text();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(body);
  });

  // -------------------------------------------------------------------------
  // GET /api/scanner/jobs/:id/json, RFC 003 § GET /scan/{scanId}/json
  // Returns the raw findings as structured JSON.
  // -------------------------------------------------------------------------

  router.get("/jobs/:id/json", async (req, res) => {
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${SCANNER_WORKER_BASE}/scan/${req.params.id}/json`, {
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      res.status(502).json({ error: "scanner_worker_unreachable", message: String(err) });
      return;
    }

    if (upstreamRes.status === 404) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (upstreamRes.status === 503) {
      res.status(503).json({ error: "scanner_unavailable" });
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      res.status(502).json({ error: "scanner_worker_error", status: upstreamRes.status, body: text });
      return;
    }

    // scanner-worker returns JSON with Content-Type: application/json
    const body = await upstreamRes.text();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(body);
  });

  // -------------------------------------------------------------------------
  // GET /api/scanner/findings
  // -------------------------------------------------------------------------

  const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);

  router.post("/findings", (req, res) => {
    const parsed = SubmitFindingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      tenantId: parsed.data.tenantId,
      originKind: "scanner_finding" as const,
      originId: parsed.data.originId ?? randomUUID(),
      severity: parsed.data.severity,
      ruleId: parsed.data.ruleId ?? null,
      title: parsed.data.title,
      description: parsed.data.description,
      remediation: parsed.data.remediation ?? null,
      affectedEndpoint: parsed.data.affectedEndpoint ?? null,
      status: "open" as const,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: now,
      updatedAt: now,
    };
    getDb().insert(scannerFindings).values(row).run();
    res.status(201).json(row);
  });

  router.get("/findings", (req, res) => {
    const db = getDb();
    const { tenantId, severity: sevRaw, status, limit = "100", offset = "0" } = req.query;

    const conditions = [];
    if (tenantId) conditions.push(eq(scannerFindings.tenantId, tenantId as string));
    if (sevRaw) {
      const sev = SeveritySchema.safeParse(sevRaw);
      if (sev.success) conditions.push(eq(scannerFindings.severity, sev.data));
    }
    if (status)
      conditions.push(eq(scannerFindings.status, status as "open" | "resolved"));

    const rows = db
      .select()
      .from(scannerFindings)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(scannerFindings.createdAt))
      .limit(Number(limit))
      .offset(Number(offset))
      .all();

    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(scannerFindings)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .get()?.count ?? 0;

    res.json({ items: rows, total, limit: Number(limit), offset: Number(offset) });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/scanner/findings/:id
  // -------------------------------------------------------------------------

  router.patch("/findings/:id", (req, res) => {
    const parsed = UpdateFindingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();

    const existing = db
      .select()
      .from(scannerFindings)
      .where(eq(scannerFindings.id, req.params.id))
      .get();

    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { status, resolvedBy, resolutionNote } = parsed.data;
    const updates: Record<string, unknown> = { updatedAt: now };
    if (status !== undefined) updates.status = status;
    if (resolvedBy !== undefined) updates.resolvedBy = resolvedBy;
    if (resolutionNote !== undefined) updates.resolutionNote = resolutionNote;
    if (status === "resolved") {
      updates.resolvedAt = now;
    }

    db.update(scannerFindings)
      .set(updates)
      .where(eq(scannerFindings.id, req.params.id))
      .run();

    const updated = db
      .select()
      .from(scannerFindings)
      .where(eq(scannerFindings.id, req.params.id))
      .get();

    res.json(updated);
  });

  return router;
}
