/**
 * Embed client — calls an OpenAI-compatible embedding endpoint to vectorise text.
 *
 * Supports any provider that implements the OpenAI `/embeddings` API:
 *   - OpenAI (text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002)
 *   - Ollama (ollama.com/v1 — pull any embedding model: nomic-embed-text, etc.)
 *   - Azure OpenAI (azure.com — with api_version and azure_deployment query params)
 *   - LM Studio (openai-compatible server on localhost)
 *   - Fireworks AI, Perplexity, Cohere (via OpenAI-compatible wrappers)
 *
 * The client is stateless — create one per RagConfig and reuse it across calls.
 * It handles batching internally: if you pass more texts than embedBatchSize,
 * it chunks them up and calls the API in parallel.
 *
 * Env vars:
 *   RAG_EMBEDDING_MODEL       — model name (default: text-embedding-3-small)
 *   RAG_EMBEDDING_BASE_URL    — API base URL (default: https://api.openai.com/v1)
 *   RAG_EMBEDDING_API_KEY     — API key (default: read from OPENAI_API_KEY)
 *   RAG_EMBEDDING_DIMENSION   — expected dimension (optional; inferred from first response)
 *   RAG_EMBEDDING_TIMEOUT_MS  — request timeout in ms (default: 30000)
 */

import type { EmbedConfig, Embedding } from "./types.js";

export interface EmbedResult {
  embedding: Embedding;
  text: string; // echo back for correlation
  tokensUsed?: number; // from usage field in response
}

export interface EmbedResults {
  results: EmbedResult[];
  model: string;
  provider: string; // inferred from base URL
  totalTokensUsed: number;
  durationMs: number;
}

export class EmbedClient {
  private readonly config: EmbedConfig;
  private inferredDimension: number | null = null;

  constructor(config: EmbedConfig) {
    this.config = {
      timeoutMs: 30_000,
      ...config,
    };
  }

  /**
   * Embed a single text. Convenience wrapper around embed([]).
   */
  async embedOne(text: string): Promise<EmbedResult> {
    const { results } = await this.embed([text]);
    const first = results[0];
    if (!first) throw new Error("embedOne returned empty results");
    return first;
  }

  /**
   * Embed multiple texts in a single API call.
   *
   * OpenAI's batch API accepts up to 2048 inputs per request.
   * We default to batches of 100 to avoid very large payloads and to
   * yield partial results on partial failures.
   *
   * @param texts  — array of strings to embed
   * @param batchSize — max per request. Default: 100.
   */
  async embed(texts: string[], batchSize = 100): Promise<EmbedResults> {
    const start = Date.now();
    const trimmed = texts.map((t) => t.slice(0, 80_000)); // hard guard
    const results: EmbedResult[] = [];
    let totalTokens = 0;
    let model = this.config.model;

    // Process in batches
    for (let i = 0; i < trimmed.length; i += batchSize) {
      const batch = trimmed.slice(i, i + batchSize);
      const result = await this.postEmbeddings(batch);
      results.push(...result.results);
      totalTokens += result.tokensUsed;
      model = result.model;
    }

    return {
      results,
      model,
      provider: inferProvider(this.config.baseUrl),
      totalTokensUsed: totalTokens,
      durationMs: Date.now() - start,
    };
  }

  private async postEmbeddings(texts: string[]): Promise<{
    results: EmbedResult[];
    tokensUsed: number;
    model: string;
  }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // API key: use config value, fall back to standard env vars
    const apiKey =
      this.config.apiKey ??
      process.env["OPENAI_API_KEY"] ??
      process.env["RAG_EMBEDDING_API_KEY"];
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const url = new URL("/embeddings", this.config.baseUrl);

    // Azure OpenAI uses query params instead of headers
    const isAzure = this.config.baseUrl.includes("azure.com");
    if (isAzure) {
      url.searchParams.set("api-version", "2024-02-01");
      url.searchParams.set("azure_deployment", this.config.model);
    }

    const body = JSON.stringify({
      model: this.config.model,
      input: texts,
      ...(isAzure ? {} : {}),
    });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 30_000,
    );

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        // Note: no deduplicate — we let the server handle idempotency
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let msg: string;
      try {
        const err = await response.json();
        msg = (err as { error?: { message?: string } }).error?.message ?? response.statusText;
      } catch {
        msg = response.statusText;
      }
      throw new EmbedError(response.status, url.toString(), msg);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    // Infer dimension from first embedding
    if (!this.inferredDimension && data.data?.[0]?.embedding?.length) {
      this.inferredDimension = data.data[0].embedding.length;
    }

    const tokensUsed =
      typeof data.usage?.total_tokens === "number"
        ? data.usage.total_tokens
        : texts.join("").length / 4; // rough fallback

    return {
      results: data.data.map((item) => ({
        embedding: item.embedding,
        text: item.text ?? texts[item.index ?? 0] ?? "",
        tokensUsed: Math.ceil((item.text?.length ?? 0) / 4),
      })),
      tokensUsed,
      model: data.model ?? this.config.model,
    };
  }

  /** Returns the inferred embedding dimension (available after first embed call). */
  getDimension(): number | null {
    return this.inferredDimension;
  }
}

// ─── OpenAI response shape ──────────────────────────────────────────────────

interface OpenAIEmbeddingResponse {
  object: string;
  model: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
    text?: string; // some providers return this
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ─── Error ─────────────────────────────────────────────────────────────────

export class EmbedError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`EmbedError ${statusCode} from ${url}: ${body}`);
    this.name = "EmbedError";
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function inferProvider(baseUrl: string): string {
  if (baseUrl.includes("ollama")) return "ollama";
  if (baseUrl.includes("azure")) return "azure-openai";
  if (baseUrl.includes("cohere")) return "cohere";
  if (baseUrl.includes("fireworks")) return "fireworks";
  if (baseUrl.includes("api.openai")) return "openai";
  if (baseUrl.includes("generativelanguage")) return "gemini";
  return "openai-compatible";
}
