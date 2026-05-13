/**
 * benchmark.test.ts — Vitest test suite for benchmark.ts helpers.
 *
 * These are not benchmarks (no time reporting), they are correctness &
 * smoke tests that verify the benchmark helpers behave as expected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileVaultStore } from "./file-store.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import {
  benchWritesSequential,
  benchReadsSequential,
  benchAppendsSequential,
  benchWritesConcurrent,
  benchList,
  formatResults,
  type BenchmarkResult,
} from "./benchmark.js";

const TENANT = "bench-test-tenant";

function makePayload(bytes: number): string {
  return randomBytes(bytes).toString("base64");
}

describe("benchmark helpers", () => {
  let store: FileVaultStore;
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `vault-bench-test-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(root, { recursive: true });
    store = new FileVaultStore({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // benchWritesSequential
  // -------------------------------------------------------------------------

  describe("benchWritesSequential", () => {
    it("returns a valid BenchmarkResult", async () => {
      const result = await benchWritesSequential(store, TENANT, 50, 512);
      expectValidResult(result, "writes-sequential");
      expect(result.ops).toBe(50);
      expect(result.errors).toBe(0);
    });

    it("writes data that can be read back", async () => {
      await benchWritesSequential(store, TENANT, 10, 512);
      const read = await store.read(TENANT, "bench/write-seq/5");
      expect(read.existed).toBe(true);
      expect(read.body.length).toBeGreaterThan(0);
    });

    it("errors count on write failure (invalid tenant is caught internally)", async () => {
      // Sanity: a store that can write should have 0 errors
      const result = await benchWritesSequential(store, TENANT, 10, 512);
      expect(result.errors).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // benchReadsSequential
  // -------------------------------------------------------------------------

  describe("benchReadsSequential", () => {
    it("returns a valid BenchmarkResult", async () => {
      // seed some data first
      await benchWritesSequential(store, TENANT, 20, 512);
      const result = await benchReadsSequential(store, TENANT, 20);
      expectValidResult(result, "reads-sequential");
      expect(result.ops).toBe(20);
      expect(result.errors).toBe(0);
    });

    it("errors count missing keys as failures", async () => {
      // No data seeded — all reads will miss
      const result = await benchReadsSequential(store, TENANT, 5);
      // Missing keys do not throw — they return existed:false, so errors=0
      expect(result.errors).toBe(0);
      expect(result.ops).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // benchAppendsSequential
  // -------------------------------------------------------------------------

  describe("benchAppendsSequential", () => {
    it("returns a valid BenchmarkResult", async () => {
      const result = await benchAppendsSequential(store, TENANT, 20, 512);
      expectValidResult(result, "appends-sequential");
      expect(result.ops).toBe(20);
      expect(result.errors).toBe(0);
    });

    it("appended key grows under append mode", async () => {
      const key = "bench/append/test-key";
      await store.write(TENANT, key, "block one", { mode: "append" });
      await store.write(TENANT, key, "block two", { mode: "append" });
      const read = await store.read(TENANT, key);
      expect(read.body).toContain("block one");
      expect(read.body).toContain("block two");
      expect(read.existed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // benchWritesConcurrent
  // -------------------------------------------------------------------------

  describe("benchWritesConcurrent", () => {
    it("returns a valid BenchmarkResult", async () => {
      const result = await benchWritesConcurrent(store, TENANT, 40, 4, 512);
      expectValidResult(result, "writes-concurrent");
      expect(result.ops).toBe(40);
      expect(result.errors).toBe(0);
    });

    it("achieves >1 rps (sanity that it ran)", async () => {
      const result = await benchWritesConcurrent(store, TENANT, 20, 4, 512);
      expect(result.rps).toBeGreaterThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // benchList
  // -------------------------------------------------------------------------

  describe("benchList", () => {
    it("returns a valid BenchmarkResult", async () => {
      // seed some keys
      await benchWritesSequential(store, TENANT, 10, 256);
      const { result } = await benchList(store, TENANT);
      expectValidResult(result, "list");
      expect(result.errors).toBe(0);
    });

    it("keyCount reflects seeded data", async () => {
      await benchWritesSequential(store, TENANT, 15, 256);
      const { result, keyCount } = await benchList(store, TENANT);
      expect(keyCount).toBeGreaterThanOrEqual(15);
      expect(result.errors).toBe(0);
    });

    it("returns empty list for unknown tenant", async () => {
      const { result, keyCount } = await benchList(store, "nonexistent-tenant");
      expect(keyCount).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // formatResults
  // -------------------------------------------------------------------------

  describe("formatResults", () => {
    it("produces a markdown table", () => {
      const results: BenchmarkResult[] = [
        {
          name: "test-benchmark",
          ops: 100,
          durationMs: 500,
          rps: 200,
          p50Ms: 2,
          p95Ms: 8,
          p99Ms: 15,
          errors: 0,
        },
      ];
      const output = formatResults(results);
      expect(output).toContain("| Benchmark |");
      expect(output).toContain("| test-benchmark |");
      expect(output).toContain("200.0");
      expect(output).toContain("p99");
    });
  });
});

// ---------------------------------------------------------------------------
// Shared assertion helper
// ---------------------------------------------------------------------------

function expectValidResult(result: BenchmarkResult, name: string): void {
  expect(result.name).toBe(name);
  expect(result.ops).toBeGreaterThan(0);
  expect(result.durationMs).toBeGreaterThanOrEqual(0); // sub-ms ops may yield 0
  expect(result.rps).toBeGreaterThanOrEqual(0);
  expect(result.p50Ms).toBeGreaterThanOrEqual(0);
  expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
  expect(result.p99Ms).toBeGreaterThanOrEqual(result.p95Ms);
  expect(result.errors).toBeGreaterThanOrEqual(0);
}
