import { describe, it, expect, beforeEach } from "vitest";
import { SignalDetector } from "./signal-detector.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function makeRoot() {
  const dir = join(tmpdir(), `signal-test-${Date.now()}-${Math.random()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("SignalDetector", () => {
  let root: string;
  const tenant = "test-tenant";

  beforeEach(async () => {
    root = await makeRoot();
    await fs.mkdir(join(root, tenant), { recursive: true });
  });

  it("recordWrite: first write sets strength to 1.0", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("projects/sgridworks");
    const signals = await sd.getSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.page).toBe("projects/sgridworks");
    expect(signals[0]!.strength).toBe(1.0);
    expect(signals[0]!.eventCount).toBe(1);
  });

  it("recordWrite: subsequent writes add 0.5", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("projects/sgridworks");
    await sd.recordWrite("projects/sgridworks");
    const signals = await sd.getSignals();
    expect(signals[0]!.strength).toBe(1.5);
    expect(signals[0]!.eventCount).toBe(2);
  });

  it("recordRead: adds 0.3 but needs prior write to cross threshold", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("wiki/concepts/agentworks"); // 1.0
    await sd.recordRead("wiki/concepts/agentworks");  // +0.3 = 1.3
    const signals = await sd.getSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.strength).toBe(1.3);
    expect(signals[0]!.eventCount).toBe(2);
  });

  it("write and read for different pages tracked independently", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("page/a"); // 1.0 — visible
    await sd.recordRead("page/b");  // 0.3 — below threshold, filtered
    const signals = await sd.getSignals();
    expect(signals.map(s => s.page)).toEqual(["page/a"]);
  });

  it("signal strength accumulates correctly across mixed events", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("page/mixed"); // 1.0
    await sd.recordWrite("page/mixed"); // +0.5 = 1.5
    await sd.recordRead("page/mixed"); // +0.3 = 1.8
    const signals = await sd.getSignals();
    expect(signals[0]!.strength).toBe(1.8);
    expect(signals[0]!.eventCount).toBe(3);
  });

  it("decay: signals older than 1 day lose 50% strength per day", async () => {
    const idxPath = join(root, tenant, ".signals.json");
    const staleDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString();
    await fs.writeFile(idxPath, JSON.stringify({
      signals: {
        "old/page": { page: "old/page", reason: "old", strength: 2.0, updatedAt: staleDate, eventCount: 2 },
      },
      lastChecked: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    }));
    const sd = new SignalDetector(root, tenant);
    const signals = await sd.getSignals();
    // 2.0 * 0.5^3 = 0.25 < 1.0 → filtered out
    expect(signals.map(s => s.page)).not.toContain("old/page");
  });

  it("getSignals: excludes signals updated before lastChecked", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("page/old");
    await sd.markChecked(); // lastChecked = now
    await new Promise(r => setTimeout(r, 20));
    await sd.recordWrite("page/new");
    const signals = await sd.getSignals();
    const pages = signals.map(s => s.page);
    expect(pages).not.toContain("page/old");
    expect(pages).toContain("page/new");
  });

  it("markChecked: advances lastChecked to now", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("page/x");
    const before = await sd.lastChecked();
    await new Promise(r => setTimeout(r, 20));
    await sd.markChecked();
    const after = await sd.lastChecked();
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("prune: removes signals below threshold", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("weak/page");   // 1.0
    await sd.recordWrite("strong/page"); // 1.0
    const idxPath = join(root, tenant, ".signals.json");
    const idx = JSON.parse(await fs.readFile(idxPath, "utf8"));
    idx.signals["weak/page"].strength = 0.5;
    await fs.writeFile(idxPath, JSON.stringify(idx));
    const removed = await sd.prune(1.0);
    expect(removed).toBeGreaterThanOrEqual(1);
    const signals = await sd.getSignals();
    expect(signals.map(s => s.page)).not.toContain("weak/page");
    expect(signals.map(s => s.page)).toContain("strong/page");
  });

  it("getSignals: respects limit", async () => {
    const sd = new SignalDetector(root, tenant);
    for (let i = 0; i < 20; i++) await sd.recordWrite(`page/${i}`);
    const signals = await sd.getSignals(5);
    expect(signals).toHaveLength(5);
  });

  it("flush: persists dirty state to disk", async () => {
    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("flush/test");
    await sd.flush();
    const idx = JSON.parse(await fs.readFile(join(root, tenant, ".signals.json"), "utf8"));
    expect(idx.signals["flush/test"]).toBeDefined();
    expect(idx.signals["flush/test"].strength).toBe(1.0);
  });

  it("isolates signals per tenant", async () => {
    const sd1 = new SignalDetector(root, "tenant-1");
    const sd2 = new SignalDetector(root, "tenant-2");
    await sd1.recordWrite("page/shared");
    await sd2.recordWrite("page/shared");
    const [sig1, sig2] = [await sd1.getSignals(), await sd2.getSignals()];
    expect(sig1[0]!.eventCount).toBe(1);
    expect(sig2[0]!.eventCount).toBe(1);
    expect(sig1).toHaveLength(1);
    expect(sig2).toHaveLength(1);
  });
});
