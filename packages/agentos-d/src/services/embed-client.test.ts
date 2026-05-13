import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbedClient, vectorToBlob, blobToVector } from "./embed-client.js";

describe("EmbedClient", () => {
  const baseUrl = "http://test-sidecar:9999";
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns empty result without a network call for empty input", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const client = new EmbedClient({ baseUrl });
    const r = await client.embed([]);
    expect(r.vectors).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to /embed and returns Float32Array vectors", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        vectors: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
        model: "stub",
        dim: 3,
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const client = new EmbedClient({ baseUrl });
    const r = await client.embed(["hello", "world"]);
    expect(r.model).toBe("stub");
    expect(r.dim).toBe(3);
    expect(r.vectors).toHaveLength(2);
    expect(r.vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(r.vectors[0])).toEqual([
      // Float32 round-trip can lose precision; use closeTo semantics
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/embed`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-2xx with status and body excerpt", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal",
    }) as unknown as typeof globalThis.fetch;
    const client = new EmbedClient({ baseUrl });
    await expect(client.embed(["x"])).rejects.toThrow(/embed sidecar 500.*internal/);
  });

  it("embedOne unwraps to a single vector", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ vectors: [[1, 2]], model: "stub", dim: 2 }),
    }) as unknown as typeof globalThis.fetch;
    const client = new EmbedClient({ baseUrl });
    const r = await client.embedOne("text");
    expect(r.vector).toBeInstanceOf(Float32Array);
    expect(Array.from(r.vector)).toEqual([1, 2]);
    expect(r.model).toBe("stub");
  });
});

describe("vectorToBlob / blobToVector", () => {
  it("round-trips Float32Array through Buffer", () => {
    const v = Float32Array.from([0.5, -1.25, 3.0, 0.0]);
    const blob = vectorToBlob(v);
    expect(blob.byteLength).toBe(16);
    const back = blobToVector(blob);
    expect(Array.from(back)).toEqual([0.5, -1.25, 3.0, 0.0]);
  });

  it("rejects byte lengths that aren't multiples of 4", () => {
    expect(() => blobToVector(Buffer.from([1, 2, 3]))).toThrow(/multiple of 4/);
  });
});
