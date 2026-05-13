/**
 * AgentWorks OS API client.
 * All calls go to the local agentos-d daemon.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface Health {
  status: string;
  version: string;
  awcp: string;
  startedAt: string;
  now: string;
}

export function getHealth() {
  return request<Health>('/api/health');
}

// ---------------------------------------------------------------------------
// Execution surface (companies / agents / issues / runs)
// ---------------------------------------------------------------------------

export interface ExecutionCompany {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAgent {
  id: string;
  tenantId: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  adapterType: string | null;
  model: string | null;
  instructionsPath: string | null;
  capabilities: string | null;
  heartbeatIntervalSec: number | null;
  wakeOnDemand: boolean | null;
  lastHeartbeatAt: string | null;
  pauseReason: string | null;
  pausedAt: string | null;
  reportsTo: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  budgetPeriodStart: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAgentRuntimeState {
  agentId: string;
  sessionId: string | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostCents: number;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
}

export interface ExecutionAgentRevision {
  id: string;
  agentId: string;
  actorKind: string;
  actorId: string | null;
  source: string | null;
  changedKeys: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionAgentTaskSession {
  id: string;
  agentId: string;
  issueId: string | null;
  taskKey: string;
  adapterType: string | null;
  sessionDisplayId: string | null;
  status: string;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAgentWakeup {
  id: string;
  agentId: string;
  source: string | null;
  triggerDetail: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  coalescedCount: number;
  createdAt: string;
}

export interface ExecutionIssue {
  id: string;
  tenantId: string;
  companyId: string;
  identifier: string;
  title: string;
  description: string | null;
  status: 'triage' | 'inbox' | 'in_progress' | 'blocked' | 'done' | 'closed' | string;
  priority: string | null;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  latestCommentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionRun {
  id: string;
  agentId: string;
  companyId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  contextSnapshot: { issueId?: string } | null;
  createdAt: string;
}

export function listCompanies(tenantId: string) {
  return request<{ items: ExecutionCompany[] }>(`/api/companies?tenantId=${tenantId}`).then(r => r.items);
}

export function listCompanyAgents(companyId: string) {
  return request<{ items: ExecutionAgent[] }>(`/api/companies/${companyId}/agents`).then(r => r.items);
}

export interface ListAgentsParams {
  tenantId: string;
  companyId?: string;
  status?: 'active' | 'paused' | 'retired';
  limit?: number;
}

export function listAgents(params: ListAgentsParams) {
  const q = new URLSearchParams();
  q.set('tenantId', params.tenantId);
  if (params.companyId) q.set('companyId', params.companyId);
  if (params.status) q.set('status', params.status);
  if (params.limit) q.set('limit', String(params.limit));
  return request<{ items: ExecutionAgent[] }>(`/api/agents?${q.toString()}`).then((r) => r.items);
}

export function getAgent(agentId: string) {
  return request<ExecutionAgent>(`/api/agents/${agentId}`);
}

export interface CreateAgentBody {
  tenantId: string;
  companyId?: string;
  name: string;
  role?: string;
  status?: 'active' | 'paused' | 'retired';
  config?: Record<string, unknown>;
}

export function createAgent(body: CreateAgentBody) {
  return request<ExecutionAgent>(`/api/agents`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ResumeAgentBody {
  clearLastError?: boolean;
  actorKind?: string;
  actorId?: string;
  source?: string;
}

export function resumeAgent(agentId: string, body: ResumeAgentBody = {}) {
  return request<ExecutionAgent>(`/api/agents/${agentId}/resume`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ExecutionProject {
  id: string;
  tenantId: string;
  companyId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function listCompanyProjects(companyId: string) {
  return request<{ items: ExecutionProject[] }>(`/api/companies/${companyId}/projects`).then((r) => r.items);
}

export interface CreateIssueBody {
  tenantId: string;
  projectId: string;
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  assigneeAgentId?: string | null;
}

export function createIssue(companyId: string, body: CreateIssueBody) {
  return request<ExecutionIssue>(`/api/companies/${companyId}/issues`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function listCompanyIssues(companyId: string) {
  return request<{ items: ExecutionIssue[] }>(`/api/companies/${companyId}/issues`).then(r => r.items);
}

export function listCompanyRuns(companyId: string) {
  return request<{ items: ExecutionRun[] }>(`/api/companies/${companyId}/heartbeat-runs`).then(r => r.items);
}

export function wakeAgent(agentId: string, payload: Record<string, unknown> = {}) {
  return request<{ wakeupId: string; dispatchId: string; status: string }>(
    `/api/agents/${agentId}/wakeup`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

export function patchAgent(
  agentId: string,
  patch: {
    name?: string;
    role?: string | null;
    status?: 'active' | 'paused' | 'retired';
    adapterType?: string | null;
    model?: string | null;
    instructionsPath?: string | null;
    capabilities?: string | null;
    heartbeatIntervalSec?: number | null;
    wakeOnDemand?: boolean | null;
    pauseReason?: string | null;
    reportsTo?: string | null;
    budgetMonthlyCents?: number;
    actorKind?: string;
    actorId?: string;
    source?: string;
  }
) {
  return request<ExecutionAgent>(`/api/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export interface AgentInstructions {
  instructionsPath: string | null;
  content: string | null;
  exists: boolean;
}

export function getAgentInstructions(agentId: string) {
  return request<AgentInstructions>(`/api/agents/${agentId}/instructions`);
}

export function putAgentInstructions(agentId: string, content: string) {
  return request<{ instructionsPath: string; bytes: number }>(
    `/api/agents/${agentId}/instructions`,
    { method: 'PUT', body: JSON.stringify({ content }) }
  );
}

export function listAgentWakeups(agentId: string, limit = 50) {
  return request<{ items: ExecutionAgentWakeup[] }>(
    `/api/agents/${agentId}/wakeups?limit=${limit}`
  ).then((r) => r.items);
}

export function getAgentRuntimeState(agentId: string) {
  return request<ExecutionAgentRuntimeState | null>(`/api/agents/${agentId}/runtime-state`);
}

export function listAgentRevisions(agentId: string, limit = 50) {
  return request<{ items: ExecutionAgentRevision[] }>(
    `/api/agents/${agentId}/revisions?limit=${limit}`
  ).then((r) => r.items);
}

export function listAgentTaskSessions(agentId: string) {
  return request<{ items: ExecutionAgentTaskSession[] }>(
    `/api/agents/${agentId}/task-sessions`
  ).then((r) => r.items);
}

export interface InboxLiteIssue {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  unblockCount: number;
  createdAt: string;
  updatedAt: string;
}

export function getAgentInboxLite(agentId: string, companyId: string) {
  return request<{ items: InboxLiteIssue[] }>(
    `/api/agents/me/inbox-lite?agentId=${agentId}&companyId=${companyId}`
  ).then((r) => r.items);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export interface LaneRole {
  role: string;
  agentIdPrefix: string;
  allow: string[];
  description: string;
}

export interface LaneConfig {
  roles: LaneRole[];
  universalAllow: string[];
}

export function getLanes() {
  return request<LaneConfig>('/api/issues/lanes');
}

export interface LaneMatchResult {
  matched: boolean;
  ambiguous: boolean;
  triage: boolean;
  role: string | null;
  agentIdPrefix: string | null;
  reason: string;
}

export function previewLaneMatch(description: string) {
  return request<LaneMatchResult>(
    `/api/issues/lane-match-preview?description=${encodeURIComponent(description)}`
  );
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export interface Tenant {
  id: string;
  name: string;
  description: string | null;
  industry: 'real_estate' | 'healthcare' | 'finance' | 'other' | null;
  vaultRoot: string;
  createdAt: string;
  updatedAt: string;
}

export function listTenants() {
  return request<Tenant[]>('/api/tenants');
}

export function createTenant(body: {
  name: string;
  description?: string;
  industry?: 'real_estate' | 'healthcare' | 'finance' | 'other';
}) {
  return request<Tenant>('/api/tenants', { method: 'POST', body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Mission Map graph
// ---------------------------------------------------------------------------

export interface MapNode {
  id: string;
  tenantId: string;
  kind: 'company' | 'project' | 'issue' | 'agent' | 'run' | 'evidence' | 'memory';
  title: string;
  status?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface MapEdge {
  id: string;
  tenantId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: 'owns' | 'blocks' | 'assigned' | 'generated' | 'references' | 'depends' | 'follows';
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface MapGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

export async function getMapGraph(tenantId: string, root?: string, depth?: number): Promise<MapGraph> {
  const params = new URLSearchParams();
  params.set('tenant_id', tenantId);
  if (root) params.set('root', root);
  if (depth) params.set('depth', String(depth));
  
  return request<MapGraph>(`/api/map/graph?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Memory vault graph
// ---------------------------------------------------------------------------

export interface VaultGraphNote {
  id: string;
  title: string;
  dir: string;
  kind: string;
  tags: string[];
  chars: number;
  edited: string;
  outgoing: number;
  backlinks: number;
}
export interface VaultGraphDir {
  dir: string;
  count: number;
  hue: number;
}
export interface VaultGraph {
  tenantId: string;
  notes: VaultGraphNote[];
  edges: [string, string][];
  dirs: VaultGraphDir[];
  generatedAt: string;
}

export async function getMemoryGraph(tenantId: string): Promise<VaultGraph> {
  const r = await request<{ ok: boolean; data: VaultGraph }>(`/api/memory/graph?tenantId=${tenantId}`);
  return r.data;
}

// ---------------------------------------------------------------------------
// Vault health: lint + hot cache
// ---------------------------------------------------------------------------

export type VaultLintKind =
  | 'orphan_page'
  | 'dead_link'
  | 'frontmatter_gap'
  | 'empty_section'
  | 'kebab_case_violation';

export interface VaultLintFinding {
  kind: VaultLintKind;
  severity: 'warn' | 'info';
  path: string;
  message: string;
}

export interface VaultLintReport {
  tenantId: string;
  ranAt: string;
  pageCount: number;
  findings: VaultLintFinding[];
  totals: Record<VaultLintKind, number>;
}

export async function getVaultLint(tenantId: string): Promise<VaultLintReport> {
  const r = await request<{ ok: boolean; data: VaultLintReport }>(`/api/memory/lint?tenantId=${tenantId}`);
  return r.data;
}

export interface HotCacheRead {
  tenantId: string;
  key: string;
  existed: boolean;
  updatedAt: string | null;
  words: number;
  body: string;
}

export async function getHotCache(tenantId: string): Promise<HotCacheRead> {
  const r = await request<{ ok: boolean; data: HotCacheRead }>(`/api/memory/hot-cache?tenantId=${tenantId}`);
  return r.data;
}

export interface HotCacheRebuildResult {
  tenantId: string;
  words: number;
  path: string;
  rebuiltAt: string;
}

export async function rebuildHotCache(tenantId: string): Promise<HotCacheRebuildResult> {
  const r = await request<{ ok: boolean; data: HotCacheRebuildResult }>(
    '/api/memory/hot-cache/rebuild',
    { method: 'POST', body: JSON.stringify({ tenantId }) },
  );
  return r.data;
}

// ---------------------------------------------------------------------------
// Rule packs
// ---------------------------------------------------------------------------

export interface RulePackSummary {
  id: string;
  packId: string;
  packName: string | null;
  packVersion: string;
  tier: string;
  shadowMode: boolean;
  createdAt: string;
}

export interface PackMode {
  mode: 'shadow' | 'enforce';
  flippedAt: string | null;
  flippedBy: string | null;
  reason: string | null;
}

export function listRulePacks(tenantId?: string) {
  const q = tenantId ? `?tenantId=${tenantId}` : '';
  return request<{ items: RulePackSummary[] }>(`/api/policy/packs${q}`).then(r => r.items);
}

export interface RulePackStat {
  packId: string;
  packVersion: string;
  rulesCount: number;
  fires24h: number;
  lastFireAt: string | null;
}

export interface RulePackStatsResponse {
  generatedAt: string;
  windowHours: number;
  tenantId: string | null;
  totals: { rulesCount: number; fires24h: number };
  items: RulePackStat[];
}

export function getRulePackStats(tenantId?: string) {
  const q = tenantId ? `?tenantId=${tenantId}` : '';
  return request<RulePackStatsResponse>(`/api/policy/packs/stats${q}`);
}

export function getRulePack(id: string) {
  return request<RulePackSummary>(`/api/policy/packs/${id}`);
}

export function updateRulePack(id: string, body: object) {
  return request<RulePackSummary>(`/api/policy/packs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export interface RulePackDraft {
  packId: string;
  yaml: string;
  savedBy: string | null;
  savedAt: string;
}

export function saveRulePackDraft(packId: string, yaml: string, savedBy?: string) {
  return request<{ packId: string; savedAt: string; savedBy: string | null }>(
    `/api/policy/packs/${packId}/draft`,
    {
      method: 'POST',
      body: JSON.stringify({ yaml, savedBy }),
    },
  );
}

export function getRulePackDraft(packId: string) {
  return request<RulePackDraft>(`/api/policy/packs/${packId}/draft`);
}

export function promoteRulePackDraft(packId: string) {
  return request<{ promoted: boolean; draft: RulePackDraft }>(
    `/api/policy/packs/${packId}/draft/promote`,
    { method: 'POST' },
  );
}

export function flipPackMode(
  packId: string,
  mode: 'shadow' | 'enforce',
  reviewerId: string,
  reason?: string,
): Promise<PackMode> {
  return request<PackMode>(`/api/policy/packs/${packId}/mode`, {
    method: 'PATCH',
    body: JSON.stringify({ mode, reviewerId, reason }),
  });
}

export function dryRunRulePack(id: string, body: object) {
  // POST /api/policy/evaluate — same evaluation engine used by policy check
  return request<{ decision: string; ruleId: string | null; reason: string }>(
    `/api/policy/evaluate`,
    { method: 'POST', body: JSON.stringify({ packId: id, ...body }) }
  );
}

export function uploadRulePack(body: FormData, tenantId?: string) {
  // POST /api/tenants/:id/rule-packs
  const id = tenantId ?? '00000000-0000-0000-0000-000000000001';
  return request<RulePackSummary>(`/api/tenants/${id}/rule-packs`, {
    method: 'POST',
    body,
  });
}

// ---------------------------------------------------------------------------
// Policy decisions / approval queue
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  id: string;
  actionId: string;
  actorId: string;
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
  tenantId: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decision: 'allow' | 'block' | 'route_to_review';
  decisionReason: string;
  shadowMode: boolean;
  reviewedAt: string | null;
  review: {
    reviewedBy: string | null;
    reviewedByLabel: string | null;
    reviewDecision: 'approve' | 'reject' | 'return_to_author' | null;
    reviewNote: string | null;
    reviewedAt: string | null;
  } | null;
  proposedAt: string;
  decidedAt: string;
}

export function listPendingApprovals(tenantId?: string) {
  const url = tenantId
    ? `/api/approval-queue?decision=route_to_review&reviewed=false&tenantId=${tenantId}`
    : '/api/approval-queue?decision=route_to_review&reviewed=false';
  return request<{ items: PolicyDecision[]; total: number }>(url).then(r => r.items);
}

export function reviewDecision(id: string, body: {
  decision: 'approve' | 'reject' | 'return_to_author';
  note?: string;
}) {
  return request<PolicyDecision>(`/api/approval-queue/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Add a comment to an issue (used for approvals UI comment affordance)
export function addIssueComment(issueId: string, commentBody: string) {
  return request<any>(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: commentBody }),
  });
}

export interface IssueComment {
  id: string;
  tenantId: string;
  issueId: string;
  authorId: string | null;
  authorLabel: string;
  body: string;
  createdAt: string;
}

export async function listIssueComments(issueId: string, limit = 25): Promise<IssueComment[]> {
  const res = await request<{ items: IssueComment[] }>(
    `/api/issues/${issueId}/comments?limit=${limit}`
  );
  return res.items;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export interface ActivityLogEntry {
  id: string;
  tenantId: string;
  actorId: string;
  actorLabel: string;
  actionKind: string;
  outcome: 'allow' | 'block' | 'route_to_review' | 'approved' | 'rejected';
  timestamp: string;
}

export interface ActivityLogParams {
  tenantId?: string;
  agentId?: string;
  actionKind?: string;
  decision?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function getActivityLog(params: ActivityLogParams = {}) {
  const qs = new URLSearchParams();
  if (params.tenantId) qs.set('tenantId', params.tenantId);
  if (params.agentId) qs.set('agentId', params.agentId);
  if (params.actionKind) qs.set('actionKind', params.actionKind);
  if (params.decision) qs.set('decision', params.decision);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return request<ActivityLogEntry[]>(`/api/activity-log${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// Scanner findings
// ---------------------------------------------------------------------------

export interface ScannerFinding {
  id: string;
  tenantId: string;
  agentId: string | null;
  agentLabel: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  ruleId: string;
  ruleName: string;
  description: string;
  filePath: string | null;
  createdAt: string;
  resolved: boolean;
  resolvedAt: string | null;
}

export function listScannerFindings(tenantId?: string) {
  const url = tenantId
    ? `/api/scanner/findings?tenantId=${tenantId}`
    : '/api/scanner/findings';
  return request<{ items: ScannerFinding[]; total: number }>(url).then(r => r.items);
}

export function resolveFinding(id: string) {
  return request<ScannerFinding>(`/api/scanner/findings/${id}/resolve`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Compliance evidence report
// ---------------------------------------------------------------------------

export interface EvidenceReport {
  id: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  summary: {
    totalDecisions: number;
    blocked: number;
    allowed: number;
    reviewed: number;
  };
}

export function getEvidenceReport(tenantId: string, periodStart: string, periodEnd: string) {
  return request<EvidenceReport>(
    `/api/compliance/evidence-report?tenantId=${tenantId}&periodStart=${periodStart}&periodEnd=${periodEnd}`
  );
}

// ---------------------------------------------------------------------------
// Persisted evidence report rows (AWO-189)
// ---------------------------------------------------------------------------

export interface EvidenceReportRow {
  id: string;
  reportId: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  engineName: string;
  pdfByteLength: number;
  status: 'complete' | 'failed';
  pdfHash: string | null;
  hmac: string | null;
  signedAt: string | null;
}

export interface EvidenceReportListResponse {
  data: EvidenceReportRow[];
  pagination: { total: number; limit: number; offset: number };
}

export function listEvidenceReports(tenantId: string, limit = 25, offset = 0) {
  const url = `/api/evidence-reports?tenantId=${tenantId}&limit=${limit}&offset=${offset}`;
  return request<EvidenceReportListResponse>(url);
}

export function generateEvidenceReport(body: { tenantId: string; periodStart: string; periodEnd: string }) {
  return request<EvidenceReportRow & { pdfBase64?: string }>('/api/evidence-reports/generate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Verify the SHA-256 of a base64-encoded PDF body matches the daemon's
 * recorded pdfHash. Pure client-side recomputation; no network call.
 */
export async function verifyEvidenceReportHash(pdfBase64: string, expectedPdfHash: string): Promise<boolean> {
  const bin = atob(pdfBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === expectedPdfHash;
}

/**
 * Fetch the evidence report and return it as a Blob ready for download.
 *
 * Today the substrate serves a structured JSON digest. When the PDF
 * templating engine lands (AWO-74 et al), this helper switches to
 * Accept: application/pdf and returns the rendered PDF; callers don't change.
 */
export async function downloadEvidenceReport(
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Blob> {
  const url = `${BASE}/api/compliance/evidence-report?tenantId=${tenantId}&periodStart=${periodStart}&periodEnd=${periodEnd}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${body}`);
  }
  const json = await res.json();
  const text = JSON.stringify(json, null, 2);
  return new Blob([text], { type: 'application/json' });
}

// ---------------------------------------------------------------------------
// Triage queue
// ---------------------------------------------------------------------------

export interface TriageIssue {
  id: string;
  identifier: string;
  title: string;
  priority: string;
  createdAt: string;
  matchedRole: string | null;
  triageReason: string | null;
  suggestedRoles: string[];
}

export interface TriageAgent {
  id: string;
  name: string;
  title: string;
}

export interface TriageQueueResponse {
  issues: TriageIssue[];
  agents: TriageAgent[];
  count: number;
}

export function getTriageQueue() {
  return request<TriageQueueResponse>('/api/admin/triage-queue');
}

export function assignTriageIssue(issueId: string, assigneeAgentId: string) {
  return request<{ success: boolean; issue: unknown }>('/api/admin/triage-queue/assign', {
    method: 'POST',
    body: JSON.stringify({ issueId, assigneeAgentId }),
  });
}

// ---------------------------------------------------------------------------
// Onboarding — editor pairing
// ---------------------------------------------------------------------------

export interface DetectedEditor {
  id: string;
  label: string;
  configPath: string;
  present: boolean;
}

export interface DetectEditorsResponse {
  editors: DetectedEditor[];
}

export interface WriteConfigResult {
  id: string;
  configPath: string;
  written: boolean;
  message: string;
}

export interface WriteConfigResponse {
  results: WriteConfigResult[];
}

export function detectEditors() {
  return request<DetectEditorsResponse>('/api/onboarding/detect-editors', {
    method: 'POST',
  });
}

export function writeEditorConfigs(reviewerId: string, editorIds: string[]) {
  return request<WriteConfigResponse>('/api/onboarding/write-config', {
    method: 'POST',
    body: JSON.stringify({ reviewerId, editorIds }),
  });
}

// ---------------------------------------------------------------------------
// Onboarding — tenant initialization (orchestrates step 1-3 in one call)
// ---------------------------------------------------------------------------

export interface InitializeOnboardingRequest {
  tenantName: string;
  tenantDescription?: string;
  industry?: 'real_estate' | 'healthcare' | 'finance' | 'other';
  selectedPack: 'minimal' | 'standard' | 'blank';
}

export interface InitializeOnboardingResponse {
  tenantId: string;
  vaultRoot: string;
}

export function initializeOnboarding(body: InitializeOnboardingRequest) {
  return request<InitializeOnboardingResponse>('/api/onboarding/initialize', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

export interface AutopilotAction {
  id: string;
  actionId: string;
  actorId: string;
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
  tenantId: string;
  proposedActionKind: string;
  proposedActionSummary: string;
  decision: 'allow' | 'needsApproval' | 'risky';
  riskScore: number;
  reasons: string[];
  proposedAt: string;
  decidedAt: string;
}

export interface AutopilotDispatchResponse {
  results: Array<{
    actionId: string;
    decision: 'allow' | 'needsApproval' | 'risky';
    riskScore: number;
    reasons: string[];
  }>;
}

export function listAutopilotActions(tenantId?: string, decision?: 'allow' | 'needsApproval' | 'risky') {
  const params = new URLSearchParams();
  if (tenantId) params.set('tenantId', tenantId);
  if (decision) params.set('decision', decision);
  
  const query = params.toString();
  return request<{ items: AutopilotAction[] }>(`/api/autopilot${query ? `?${query}` : ''}`).then(r => r.items);
}

export function dispatchAutopilotActions(actionIds: string[], dryRun = false) {
  return request<AutopilotDispatchResponse>('/api/autopilot/dispatch', {
    method: 'POST',
    body: JSON.stringify({ actionIds, dryRun }),
  });
}

export function getAutopilotSettings(tenantId: string) {
  return request<{ enabled: boolean; threshold: number }>(`/api/tenants/${tenantId}/autopilot`);
}

export function updateAutopilotSettings(tenantId: string, enabled: boolean, threshold = 0.3) {
  return request<{ enabled: boolean; threshold: number }>(`/api/tenants/${tenantId}/autopilot`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled, threshold }),
  });
}

// ---------------------------------------------------------------------------
// Memory provenance
// ---------------------------------------------------------------------------

export interface ProvenanceMeta {
  path: string;
  authoringAgent: string | null;
  lastUpdatedBy: string | null;
  lastUpdatedAt: string | null;
  lastUsedBy: string[];
  readWindowDays: number;
}

export async function getMemoryProvenance(tenantId: string, path: string): Promise<ProvenanceMeta | null> {
  try {
    const r = await request<{ ok: boolean; data: ProvenanceMeta }>(`/api/memory/provenance?tenantId=${tenantId}&path=${encodeURIComponent(path)}`);
    return r.data;
  } catch (err) {
    // Return null if provenance doesn't exist (404) or any other error
    return null;
  }
}

// ---------------------------------------------------------------------------
// Insights — phase 1b memory architecture
// ---------------------------------------------------------------------------

export type InsightFrameType =
  | 'preference'
  | 'fact'
  | 'plan'
  | 'constraint'
  | 'feedback'
  | 'error_pattern';

export type InsightSource =
  | 'agent_reflection'
  | 'user_correction'
  | 'task_outcome'
  | 'manual';

export interface Insight {
  id: string;
  frameType: InsightFrameType;
  subject: string | null;
  content: string;
  source: InsightSource;
  importance: number;
  validated: boolean;
  episodeId: string | null;
  createdAt: string;
}

export interface ListInsightsParams {
  tenantId: string;
  frameType?: InsightFrameType;
  subject?: string;
  lifecycle?: 'active' | 'archived' | 'invalidated';
  limit?: number;
}

export async function listInsights(params: ListInsightsParams): Promise<Insight[]> {
  const q = new URLSearchParams();
  q.set('tenantId', params.tenantId);
  if (params.frameType) q.set('frameType', params.frameType);
  if (params.subject) q.set('subject', params.subject);
  if (params.lifecycle) q.set('lifecycle', params.lifecycle);
  if (params.limit) q.set('limit', String(params.limit));
  const r = await request<{ ok: boolean; data: { count: number; items: Insight[] } }>(
    `/api/memory/insight?${q.toString()}`,
  );
  return r.data.items;
}

export interface UpdateInsightBody {
  tenantId: string;
  content?: string;
  validated?: boolean;
  importance?: number;
  subject?: string | null;
}

export async function updateInsight(id: string, body: UpdateInsightBody): Promise<Insight> {
  const r = await request<{ ok: boolean; data: Insight }>(
    `/api/memory/insight/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return r.data;
}

export async function archiveInsight(id: string, tenantId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/memory/insight/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ tenantId }),
  });
}
