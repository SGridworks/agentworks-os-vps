/**
 * RerankClient — calls the scanner-worker /rerank sidecar to score
 * (query, candidate) pairs with a cross-encoder (BAAI/bge-reranker-base).
 *
 * RRF fusion in retrieval.ts is robust but blunt — it cares only about
 * ranks, not relevance distance. After fusion we have a top-N set worth
 * paying ~50ms per call to re-rank with a small cross-encoder before
 * returning to the caller. Stub mode returns 0.0 for every candidate so
 * callers in test/CI environments can run end-to-end without torch.
 */

const DEFAULT_BASE_URL =
  process.env.SCANNER_SIDECAR_URL ?? "http://127.0.0.1:3101";

export interface RerankClientOpts {
  baseUrl?: string;
  /** Per-request timeout. Default 15s — cross-encoder is slower than embed. */
  timeoutMs?: number;
}

export interface RerankResult {
  scores: number[];
  model: string;
  mode: string;
}

export class RerankClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: RerankClientOpts = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Score each candidate against the query. Empty candidates returns
   * empty scores without a network round-trip.
   */
  async rerank(query: string, candidates: string[]): Promise<RerankResult> {
    if (candidates.length === 0) {
      return { scores: [], model: "", mode: "" };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, candidates }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`rerank sidecar ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      scores: number[];
      model: string;
      mode: string;
    };

    return { scores: data.scores, model: data.model, mode: data.mode };
  }
}
