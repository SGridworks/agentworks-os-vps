/**
 * benchmark.ts — stress-test / perf probe for FileVaultStore.
 *
 * Run directly:
 *   npx tsx src/benchmark.ts
 *   npx vitest run src/benchmark.test.ts
 *
 * Or import the helpers from any test file:
 *   import { runSuite, estimateRps } from "./benchmark.js";
 */

import { FileVaultStore } from "./file-store.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  name: string;
  ops: number; // total operations performed
  durationMs: number;
  rps: number; // operations per second
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errors: number;
}

export interface BenchmarkOptions {
  /** Number of workers (default: 4) */
  concurrency?: number;
  /** Operations per worker (default: 1000) */
  opsPerWorker?: number;
  /** Payload size in bytes for write/read tests (default: 1024) */
  payloadBytes?: number;
  /** Tenant ID used for all ops (default: "bench-tenant") */
  tenantId?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function median(ms: number[]): number {
  if (ms.length === 0) return 0;
  if (ms.length === 1) return ms[0]!;
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function percentile(ms: number[], p: number): number {
  if (ms.length === 0) return 0;
  const sorted = [...ms].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function makePayload(bytes: number): string {
  return randomBytes(bytes).toString("base64");
}

async function withTempStore<T>(fn: (store: FileVaultStore, root: string) => Promise<T>): Promise<T> {
  const root = join(tmpdir(), `vault-bench-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    const store = new FileVaultStore({ root });
    return await fn(store, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Individual benchmarks
// ---------------------------------------------------------------------------

/**
 * Sequential writes — measures replace-mode latency and throughput.
 */
export async function benchWritesSequential(
  store: FileVaultStore,
  tenantId: string,
  ops: number,
  payloadBytes: number,
): Promise<BenchmarkResult> {
  const payload = makePayload(payloadBytes);
  const latencies: number[] = [];
  let errors = 0;

  const start = Date.now();
  for (let i = 0; i < ops; i++) {
    const key = `bench/write-seq/${i}`;
    const t0 = Date.now();
    try {
      await store.write(tenantId, key, payload, { mode: "replace" });
      latencies.push(Date.now() - t0);
    } catch {
      errors++;
    }
  }
  const durationMs = Date.now() - start;

  return {
    name: "writes-sequential",
    ops,
    durationMs,
    rps: ops / (durationMs / 1000),
    p50Ms: median(latencies),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    errors,
  };
}

/**
 * Sequential reads — measures read latency after writes are done.
 */
export async function benchReadsSequential(
  store: FileVaultStore,
  tenantId: string,
  ops: number,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];
  let errors = 0;

  const start = Date.now();
  for (let i = 0; i < ops; i++) {
    const key = `bench/read-seq/${i}`;
    const t0 = Date.now();
    try {
      await store.read(tenantId, key);
      latencies.push(Date.now() - t0);
    } catch {
      errors++;
    }
  }
  const durationMs = Date.now() - start;

  return {
    name: "reads-sequential",
    ops,
    durationMs,
    rps: ops / (durationMs / 1000),
    p50Ms: median(latencies),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    errors,
  };
}

/**
 * Append-mode writes — measures timestamped block append throughput.
 */
export async function benchAppendsSequential(
  store: FileVaultStore,
  tenantId: string,
  ops: number,
  payloadBytes: number,
): Promise<BenchmarkResult> {
  const payload = makePayload(payloadBytes);
  const latencies: number[] = [];
  let errors = 0;

  const start = Date.now();
  for (let i = 0; i < ops; i++) {
    const key = `bench/append/${i % 10}`; // keep 10 keys to exercise append on same file
    const t0 = Date.now();
    try {
      await store.write(tenantId, key, payload, { mode: "append" });
      latencies.push(Date.now() - t0);
    } catch {
      errors++;
    }
  }
  const durationMs = Date.now() - start;

  return {
    name: "appends-sequential",
    ops,
    durationMs,
    rps: ops / (durationMs / 1000),
    p50Ms: median(latencies),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    errors,
  };
}

/**
 * Concurrent writes — simulates parallel agent activity.
 */
export async function benchWritesConcurrent(
  store: FileVaultStore,
  tenantId: string,
  totalOps: number,
  concurrency: number,
  payloadBytes: number,
): Promise<BenchmarkResult> {
  const payload = makePayload(payloadBytes);
  const latencies: number[] = [];
  let errors = 0;

  const worker = async (offset: number): Promise<void> => {
    for (let i = offset; i < totalOps; i += concurrency) {
      const key = `bench/write-c/${i}`;
      const t0 = Date.now();
      try {
        await store.write(tenantId, key, payload, { mode: "replace" });
        latencies.push(Date.now() - t0);
      } catch {
        errors++;
      }
    }
  };

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  const start = Date.now();
  await Promise.all(workers);
  const durationMs = Date.now() - start;

  return {
    name: "writes-concurrent",
    ops: totalOps,
    durationMs,
    rps: totalOps / (durationMs / 1000),
    p50Ms: median(latencies),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    errors,
  };
}

/**
 * List benchmark — measures full tenant key enumeration.
 */
export async function benchList(
  store: FileVaultStore,
  tenantId: string,
): Promise<{ result: BenchmarkResult; keyCount: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let keyCount = 0;

  const start = Date.now();
  try {
    const keys = await store.list(tenantId);
    keyCount = keys.length;
    latencies.push(Date.now() - start);
  } catch {
    errors++;
  }
  const durationMs = Date.now() - start;

  return {
    result: {
      name: "list",
      ops: 1,
      durationMs,
      rps: 1 / (durationMs / 1000),
      p50Ms: latencies[0] ?? 0,
      p95Ms: latencies[0] ?? 0,
      p99Ms: latencies[0] ?? 0,
      errors,
    },
    keyCount,
  };
}

// ---------------------------------------------------------------------------
// Composite suite
// ---------------------------------------------------------------------------

export interface SuiteOptions extends BenchmarkOptions {
  /** Write a seeded set of keys before read tests (default: true) */
  seedBeforeRead?: boolean;
  /** Run concurrent write test (default: true) */
  concurrentWrites?: boolean;
}

const DEFAULTS: Required<SuiteOptions> = {
  concurrency: 4,
  opsPerWorker: 1000,
  payloadBytes: 1024,
  tenantId: "bench-tenant",
  seedBeforeRead: true,
  concurrentWrites: true,
};

/**
 * Run a full benchmark suite and return all results.
 */
export async function runSuite(opts: SuiteOptions = {}): Promise<{
  results: BenchmarkResult[];
  storeRoot: string;
}> {
  const o = { ...DEFAULTS, ...opts };
  let store: FileVaultStore;
  let storeRoot = "";

  const result = await withTempStore(async (s, root) => {
    store = s;
    storeRoot = root;
    const tenantId = o.tenantId;
    const results: BenchmarkResult[] = [];

    // Seed data for read test
    if (o.seedBeforeRead) {
      const seedOps = Math.min(o.opsPerWorker, 500);
      const r = await benchWritesSequential(store, tenantId, seedOps, o.payloadBytes);
      results.push(r);
    }

    // Sequential writes
    results.push(
      await benchWritesSequential(store, tenantId, o.opsPerWorker, o.payloadBytes),
    );

    // Sequential reads (after writes above)
    results.push(
      await benchReadsSequential(store, tenantId, o.opsPerWorker),
    );

    // Appends
    results.push(
      await benchAppendsSequential(store, tenantId, Math.floor(o.opsPerWorker / 2), o.payloadBytes),
    );

    // Concurrent writes
    if (o.concurrentWrites) {
      results.push(
        await benchWritesConcurrent(
          store,
          tenantId,
          o.opsPerWorker,
          o.concurrency,
          o.payloadBytes,
        ),
      );
    }

    // List
    const { result: listResult, keyCount } = await benchList(store, tenantId);
    results.push(listResult);
    void keyCount; // available for reporting

    return results;
  });

  return { results: result, storeRoot };
}

/**
 * Format results as a markdown table string.
 */
export function formatResults(results: BenchmarkResult[]): string {
  const header = `| Benchmark | Ops | Duration | RPS | p50 | p95 | p99 | Errors |`;
  const sep = `|-----------|-----|----------|-----|-----|-----|-----|--------|`;
  const rows = results.map((r) =>
    `| ${r.name} | ${r.ops} | ${r.durationMs}ms | ${r.rps.toFixed(1)} | ${r.p50Ms}ms | ${r.p95Ms}ms | ${r.p99Ms}ms | ${r.errors} |`,
  );
  return [header, sep, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { runSuite, formatResults } = await import("./benchmark.js");
  console.log("\n## FileVaultStore Benchmark\n");
  const { results } = await runSuite();
  console.log(formatResults(results));
  console.log();
}
