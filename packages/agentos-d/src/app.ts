import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { pino } from "pino";
import type { Config } from "./config.js";
import {
  createPolicyRouter,
  createScannerRouter,
  createApprovalQueueRouter,
  createActionRouter,
  createMcpRouter,
  createTenantsRouter,
  createComplianceRouter,
  createWebhooksRouter,
  createWebhooksAdminRouter,
  createMemoryRouter,
  createDispatchRouter,
  createExecutionRouter,
  createOnboardingRouter,
  createCompatProxyRouter,
} from "./routes/index.js";
import { createCircuitBreakerRouter } from "./routes/circuit-breaker.js";
import { createCostMeterRouter } from "./cost-meter/cost-meter-router.js";
import { createAdminRouter } from "./routes/admin.js";
import { createIssuesRouter } from "./routes/issues.js";
import { createAgentRouter } from "./routes/agent.js";
import { createEvidenceReportsRouter } from "./routes/evidence-reports.js";
import { healthHandler } from "./health-handler.js";
import { createProxyAwareMiddleware, DEFAULT_TRANSPARENT_PROXY_CONFIG } from "./middleware/proxy-aware.js";

const STARTED_AT = new Date().toISOString();
const PACKAGE_VERSION = "0.1.0";

export function createApp(config: Config): Express {
  const logger = pino({ level: config.logLevel });
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  // Transparent proxy detection — must be registered before any route handlers
  // so that req.upstreamClient is available for policy evaluation and audit logging.
  app.use(createProxyAwareMiddleware({ config: DEFAULT_TRANSPARENT_PROXY_CONFIG }));

  // Health
  app.get("/api/health", (req, res) => healthHandler(req, res, config));

  // Policy engine
  app.use("/api/policy", createPolicyRouter(config));

  // Scanner
  app.use("/api/scanner", createScannerRouter(config));

  // Approval queue
  app.use("/api/approval-queue", createApprovalQueueRouter(config));

  // Action log
  app.use("/api/action", createActionRouter(config));

  // MCP (Model Context Protocol) — JSON-RPC 2.0 over HTTP
  app.use("/api/mcp", createMcpRouter(config));

  // Tenants (registry consumed by the onboarding wizard + admin UI)
  app.use("/api/tenants", createTenantsRouter(config));

  // Compliance evidence reports (period-aggregated policy decisions)
  app.use("/api/compliance", createComplianceRouter(config));

  // Tenant webhook subscriptions (mounted under /api/tenants for tenant-scoped CRUD).
  app.use("/api/tenants", createWebhooksRouter(config));
  app.use("/api/webhooks", createWebhooksAdminRouter(config));

  app.use("/api/memory", createMemoryRouter(config));

  // Dispatch queue — substrate-initiated tasks bound for target agents.
  app.use("/api/dispatch", createDispatchRouter(config));

  // Execution work graph — native tenant/company/project/issue API.
  app.use("/api", createExecutionRouter(config));

  // Circuit breaker — provider failover and health monitoring
  app.use("/api/providers", createCircuitBreakerRouter(config));

  // Cost meter — LLM proxy with circuit breaker protection
  // Returns { router, registerCircuitHandler } so main.ts can wire CB events to ProcessWatcher.
  const { router: costMeterRouter, registerCircuitHandler } = createCostMeterRouter(config);
  app.use("/api/proxy", costMeterRouter);

  // Admin — pause/resume + daemon status
  const adminRouter = createAdminRouter(config);
  app.use("/api/admin", adminRouter);
  // Alias: UI's getActivityLog() hits /api/activity-log (not /api/admin/activity-log).
  // Rewrite the path so the same handler under /api/admin/activity-log answers.
  app.use("/api/activity-log", (req, res, next) => {
    req.url = `/activity-log${req.url === "/" ? "" : req.url}`;
    adminRouter(req, res, next);
  });

  // Issues — auto-assign router (RFC 008 Section 3)
  app.use("/api/issues", createIssuesRouter(config));

  // Agent — inbox-lite with critical-path sorting
  app.use("/api/agents", createAgentRouter(config));

  // Evidence-reports — PDF generation + listing for compliance evidence
  app.use("/api/evidence-reports", createEvidenceReportsRouter(config));

  // Onboarding wizard helpers — detect editors + write back agentos-mcp-stdio
  app.use("/api/onboarding", createOnboardingRouter(config));

  // Compatibility proxy for daemon-critical legacy routes.
  // Mounted after native routes so AWOS implementations win as they land.
  app.use(createCompatProxyRouter(config));

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Attach registerCircuitHandler as an Express app property so cli.ts can
  // wire circuit-breaker events to the ProcessWatcher without changing the
  // return type (tests pass the Express app directly to supertest).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).registerCircuitHandler = registerCircuitHandler;

  return app;
}
