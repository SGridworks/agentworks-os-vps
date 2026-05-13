// Thin HTTP client for the AWOS execution API.
// Used by ProcessWatcher to fetch issues, agents, and post comments.

export interface AwosIssue {
  id: string;
  identifier: string;
  status: string;
  priority?: string;
  createdAt?: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt?: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  latestCommentAt: string | null;
}

export interface AwosComment {
  id: string;
  createdAt: string;
  body: string;
}

export class AwosApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`AWOS API ${res.status} on GET ${path}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`AWOS API ${res.status} on POST ${path}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  // Fetch all issues for the given company in the given statuses.
  async getIssues(companyId: string, statuses: string[]): Promise<AwosIssue[]> {
    const results: AwosIssue[][] = await Promise.all(
      statuses.map(async (status) => {
        const data = await this.get<{ items: AwosIssue[] }>(
          `/api/companies/${companyId}/issues?status=${status}&limit=500`
        );
        return (data.items ?? []).map(normalizeIssue);
      })
    );
    return results.flat();
  }

  // Get all agents for the company.
  async getAgents(companyId: string): Promise<Array<{ id: string; name: string }>> {
    const data = await this.get<{ items: Array<{ id: string; name: string }> }>(
      `/api/companies/${companyId}/agents`
    );
    return data.items;
  }

  // Get comments for an issue (newest first, limit 1)
  async getLastComment(issueId: string): Promise<AwosComment | null> {
    const data = await this.get<{ items: AwosComment[] } | AwosComment[]>(
      `/api/issues/${issueId}/comments?limit=1&sort=desc`
    );
    if (Array.isArray(data)) return data[0] ?? null;
    return data.items?.[0] ?? null;
  }

  // Post a comment on an issue. Errors are non-fatal — log and continue.
  async postComment(issueId: string, body: string): Promise<boolean> {
    try {
      await this.post(`/api/issues/${issueId}/comments`, { body, authorLabel: "ProcessWatcher" });
      return true;
    } catch (e) {
      console.error(`[AwosApiClient] postComment failed for ${issueId}:`, e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}

function normalizeIssue(issue: AwosIssue): AwosIssue {
  return {
    ...issue,
    identifier: issue.identifier ?? issue.id,
    executionRunId: issue.executionRunId ?? null,
    latestCommentAt: issue.latestCommentAt ?? null,
  };
}
