/**
 * BFF proxy: GET /api/admin/triage-queue
 *
 * Queries agentos-d for unassigned open issues, then enriches with the agent
 * roster so the UI can show assignment options.
 */

export const dynamic = "force-dynamic";

const AGENTOS_BASE = process.env.AGENTOS_API_URL ?? "http://127.0.0.1:7710";
const TENANT_ID = process.env.AGENTOS_TENANT_ID ?? null;
const COMPANY_ID = process.env.AGENTOS_COMPANY_ID ?? null;
const COMPANY_NAME = process.env.AGENTOS_COMPANY_NAME ?? "AgentWorks";

interface AwosList<T> {
  items: T[];
}

interface AwosTenant {
  id: string;
  name: string;
}

interface AwosCompany {
  id: string;
  name: string;
}

interface AwosIssue {
  id: string;
  identifier: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AwosAgent {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
  status: string;
}

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

async function fetchAgentos<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENTOS_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...( { next: { revalidate: 0 } } as unknown as RequestInit ),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`agentos-d ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function resolveTenantId(): Promise<string> {
  if (TENANT_ID) return TENANT_ID;
  const tenants = await fetchAgentos<AwosTenant[]>("/api/tenants");
  const firstTenant = tenants[0];
  if (!firstTenant) {
    throw new Error("No tenant exists yet");
  }
  return firstTenant.id;
}

async function resolveCompanyId(): Promise<string> {
  if (COMPANY_ID) return COMPANY_ID;
  const tenantId = await resolveTenantId();
  const path = `/api/companies?tenantId=${encodeURIComponent(tenantId)}`;
  const companies = await fetchAgentos<AwosList<AwosCompany>>(path);
  const selected =
    companies.items.find((c) => c.name === COMPANY_NAME) ?? companies.items[0];
  if (!selected) {
    throw new Error(`No company exists yet for tenant ${tenantId}`);
  }
  return selected.id;
}

function extractMatchedRole(description: string): string | null {
  // The lane-matcher stores the matched role in the auto-assign response,
  // but that is not persisted on the issue. We do a best-effort regex
  // against common lane prefixes in the description.
  const lanes = [
    "BackendEngineer",
    "FrontendEngineer",
    "PythonEngineer",
    "ComplianceConsultant",
    "TechnicalWriter",
    "QAEngineer",
    "TechLead",
  ];
  for (const lane of lanes) {
    if (description.includes(lane)) return lane;
  }
  return null;
}

function extractSuggestedRoles(description: string): string[] {
  // Best-effort extraction of candidate roles from the description.
  const lanes = [
    "BackendEngineer",
    "FrontendEngineer",
    "PythonEngineer",
    "ComplianceConsultant",
    "TechnicalWriter",
    "QAEngineer",
    "TechLead",
  ];
  const found: string[] = [];
  for (const lane of lanes) {
    if (description.includes(lane)) found.push(lane);
  }
  return found;
}

export async function GET(): Promise<Response> {
  try {
    let companyId: string;
    try {
      companyId = await resolveCompanyId();
    } catch (resolveErr) {
      // A clean install has a tenant but no company yet. Return an empty
      // queue with setup guidance instead of a 500 — the dashboard renders
      // a "create your first company" state.
      const reason = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
      if (/No (tenant|company) /i.test(reason)) {
        return Response.json({
          issues: [],
          agents: [],
          count: 0,
          setupRequired: true,
          notice: "No company found for the active tenant yet. Create one to populate the triage queue.",
        });
      }
      throw resolveErr;
    }
    const issueResponse = await fetchAgentos<AwosList<AwosIssue>>(
      `/api/companies/${companyId}/issues`
    );
    const issues = issueResponse.items;

    const triageIssues: TriageIssue[] = issues
      .filter(
        (i) =>
          (i.assigneeAgentId === null || i.assigneeAgentId === undefined) &&
          i.status !== "done" &&
          i.status !== "closed"
      )
      .map((i) => {
        const description = i.description ?? "";
        const matched = extractMatchedRole(description);
        const suggested = extractSuggestedRoles(description);
        return {
          id: i.id,
          identifier: i.identifier ?? i.id,
          title: i.title,
          priority: i.priority,
          createdAt: i.createdAt,
          matchedRole: matched,
          triageReason: matched ?? "No matching lane found",
          suggestedRoles: suggested.length > 0 ? suggested : matched ? [matched] : [],
        };
      })
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

    const agentResponse = await fetchAgentos<AwosList<AwosAgent>>(
      `/api/companies/${companyId}/agents`
    );
    const agents = agentResponse.items;

    const activeAgents: TriageAgent[] = agents
      .filter((a) => a.status !== "paused" && a.status !== "retired")
      .map((a) => ({
        id: a.id,
        name: a.name,
        title: a.title ?? a.role ?? a.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const payload: TriageQueueResponse = {
      issues: triageIssues,
      agents: activeAgents,
      count: triageIssues.length,
    };

    return Response.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[triage-queue] GET failed:", message);
    return Response.json({ error: "fetch_failed", message }, { status: 500 });
  }
}
