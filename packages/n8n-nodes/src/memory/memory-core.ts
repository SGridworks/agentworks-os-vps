/**
 * Core implementation for the agentworks.memory.read and agentworks.memory.write
 * n8n custom nodes.
 *
 * Both nodes are thin wrappers over `POST /api/memory/{read,write}` on the
 * agentos-d daemon. The node files (MemoryRead.node.ts, MemoryWrite.node.ts)
 * own the n8n descriptor; the HTTP plumbing and result shaping live here so
 * we can test it without dragging the n8n runtime into vitest.
 */

export interface MemoryClientOptions {
  /** Daemon base URL, e.g. "http://127.0.0.1:3100". */
  baseUrl: string;
  /** Optional bearer token. */
  apiKey?: string;
  /** Request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override fetch — mainly for tests. */
  fetchImpl?: typeof fetch;
}

export interface MemoryReadParams {
  tenantId: string;
  key: string;
  tier?: "index" | "detail";
}

export interface MemoryWriteParams {
  tenantId: string;
  key: string;
  body: string;
  mode?: "replace" | "append";
}

export interface MemoryReadData {
  tenantId: string;
  key: string;
  body?: string;
  sha256: string;
  updatedAt: string;
  existed: boolean;
  summary?: string;
  trigger?: string;
}

export interface MemoryWriteData {
  tenantId: string;
  key: string;
  bytesWritten: number;
  sha256: string;
  updatedAt: string;
  mode: "replace" | "append";
}

export type MemoryReadResult =
  | { ok: true; data: MemoryReadData }
  | { ok: false; error: string };

export type MemoryWriteResult =
  | { ok: true; data: MemoryWriteData }
  | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runMemoryRead(
  params: MemoryReadParams,
  options: MemoryClientOptions,
): Promise<MemoryReadResult> {
  if (!params.tenantId) return { ok: false, error: "tenantId is required" };
  if (!params.key) return { ok: false, error: "key is required" };

  return postMemory<MemoryReadData>(
    "/api/memory/read",
    { tenantId: params.tenantId, key: params.key, tier: params.tier ?? "detail" },
    options,
  );
}

export async function runMemoryWrite(
  params: MemoryWriteParams,
  options: MemoryClientOptions,
): Promise<MemoryWriteResult> {
  if (!params.tenantId) return { ok: false, error: "tenantId is required" };
  if (!params.key) return { ok: false, error: "key is required" };
  if (typeof params.body !== "string") {
    return { ok: false, error: "body must be a string" };
  }

  const requestBody: Record<string, unknown> = {
    tenantId: params.tenantId,
    key: params.key,
    body: params.body,
  };
  if (params.mode) requestBody.mode = params.mode;

  return postMemory<MemoryWriteData>("/api/memory/write", requestBody, options);
}

async function postMemory<T>(
  path: string,
  body: Record<string, unknown>,
  options: MemoryClientOptions,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const url = `${options.baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, error: `non-JSON response (HTTP ${response.status})` };
    }

    if (!response.ok) {
      const obj = parsed as { error?: unknown; message?: unknown };
      const reason =
        typeof obj.error === "string"
          ? obj.error
          : typeof obj.message === "string"
            ? obj.message
            : `HTTP ${response.status}`;
      return { ok: false, error: reason };
    }

    const reply = parsed as { ok?: boolean; data?: T; error?: string };
    if (reply.ok === true && reply.data) {
      return { ok: true, data: reply.data };
    }
    return { ok: false, error: reply.error ?? "vault returned unexpected shape" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
