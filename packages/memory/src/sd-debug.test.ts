import { describe, it, expect } from "vitest";
import { SignalDetector } from "./signal-detector.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("DEBUG", () => {
  it("debug", async () => {
    const root = join(tmpdir(), `sd-debug-${Date.now()}`);
    const tenant = "test";
    await fs.mkdir(join(root, tenant), { recursive: true });

    const sd = new SignalDetector(root, tenant);
    await sd.recordWrite("projects/test");

    const idx = await fs.readFile(join(root, tenant, ".signals.json"), "utf8");
    console.log("signals index:", idx);

    const signals = await sd.getSignals();
    console.log("getSignals():", signals);

    expect(signals.length).toBeGreaterThan(0);
  });
});
