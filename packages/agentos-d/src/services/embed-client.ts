/**
 * EmbedClient — calls the scanner-worker /embed sidecar to produce dense
 * sentence embeddings for episode summaries and insight content.
 *
 * The sidecar runs the actual model (BAAI/bge-base-en-v1.5, 768-dim) so
 * agentos-d stays free of torch/transformers. When the sidecar is in
 * stub mode (EMBEDDING_MODE=stub) it returns deterministic hash-based
 * vectors of the same dimension — useful for local development and
 * tests without a model download.
 *
 * Vectors come back as plain number[] over JSON; we convert to Float32Array
 * before returning so callers can serialise compactly to a SQLite BLOB.
 */

const DEFAULT_BASE_URL =
  process.env.SCANNER_SIDECAR_URL ?? "http://127.0.0.1:3101";

export interface EmbedClientOpts {
  baseUrl?: string;
  /** Per-request timeout. Default 15s. */
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: Float32Array[];
  model: string;
  dim: number;
}

export class EmbedClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: EmbedClientOpts = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Embed an array of texts. Empty input returns empty result without
   * a network round-trip.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { vectors: [], model: "", dim: 0 };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embed sidecar ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      vectors: number[][];
      model: string;
      dim: number;
    };

    return {
      vectors: data.vectors.map((v) => Float32Array.from(v)),
      model: data.model,
      dim: data.dim,
    };
  }

  async embedOne(text: string): Promise<{ vector: Float32Array; model: string; dim: number }> {
    const r = await this.embed([text]);
    if (r.vectors.length === 0) {
      throw new Error("embed sidecar returned no vector");
    }
    return { vector: r.vectors[0]!, model: r.model, dim: r.dim };
  }
}

/**
 * Encode a Float32Array as a Buffer suitable for SQLite BLOB storage.
 * Uses host byte order (little-endian on all platforms we ship to).
 */
export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Decode a Buffer (or Uint8Array) back to a Float32Array. Length must
 * be a multiple of 4.
 */
export function blobToVector(buf: Buffer | Uint8Array): Float32Array {
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`embedding blob byte length ${buf.byteLength} is not a multiple of 4`);
  }
  const ab = buf instanceof Buffer
    ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
