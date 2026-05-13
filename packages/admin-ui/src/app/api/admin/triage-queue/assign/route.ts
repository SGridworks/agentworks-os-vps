/**
 * BFF proxy: POST /api/admin/triage-queue/assign
 *
 * Body: { issueId: string, assigneeAgentId: string }
 *
 * Patches the issue in agentos-d to set the assignee.
 */

export const dynamic = "force-dynamic";

const AGENTOS_BASE = process.env.AGENTOS_API_URL ?? "http://127.0.0.1:7710";

interface AssignRequest {
  issueId: string;
  assigneeAgentId: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: AssignRequest;
  try {
    body = (await request.json()) as AssignRequest;
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const { issueId, assigneeAgentId } = body;
  if (!issueId || typeof issueId !== "string") {
    return Response.json(
      { error: "invalid_request", message: "issueId is required" },
      { status: 400 }
    );
  }
  if (!assigneeAgentId || typeof assigneeAgentId !== "string") {
    return Response.json(
      { error: "invalid_request", message: "assigneeAgentId is required" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`${AGENTOS_BASE}/api/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assigneeAgentId,
        status: "todo",
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return Response.json(
        { error: "agentos_error", message: `${res.status} ${text}` },
        { status: 502 }
      );
    }

    const updated = await res.json();
    return Response.json({ success: true, issue: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[triage-queue/assign] POST failed:", message);
    return Response.json(
      { error: "fetch_failed", message },
      { status: 500 }
    );
  }
}
