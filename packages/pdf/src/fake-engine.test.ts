/**
 * FakePdfEngine tests.
 *
 *   - returns a real, valid PDF byte sequence (starts with %PDF, ends with %%EOF)
 *   - renders the title from <title>
 *   - is deterministic for the same input
 *   - shutdown is idempotent
 */

import { describe, it, expect } from "vitest";
import { FakePdfEngine } from "./fake-engine.js";
import { isPdfBytes } from "./engine.js";

describe("FakePdfEngine", () => {
  it("renders valid PDF bytes that start with %PDF and end with %%EOF", async () => {
    const engine = new FakePdfEngine();
    const result = await engine.render(
      "<html><head><title>AWO Evidence</title></head><body>hi</body></html>",
    );
    expect(result.contentType).toBe("application/pdf");
    expect(result.byteLength).toBeGreaterThan(200);
    expect(isPdfBytes(result.bytes)).toBe(true);
    const tail = Buffer.from(result.bytes.slice(-6)).toString("binary");
    expect(tail).toContain("%%EOF");
    expect(result.pageCount).toBe(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is deterministic for identical input (modulo timestamp)", async () => {
    const engine = new FakePdfEngine();
    const a = await engine.render("<html><head><title>X</title></head></html>");
    const b = await engine.render("<html><head><title>X</title></head></html>");
    expect(a.byteLength).toBe(b.byteLength);
    expect(Buffer.from(a.bytes).toString("binary")).toBe(
      Buffer.from(b.bytes).toString("binary"),
    );
  });

  it("differs when html differs (hash changes)", async () => {
    const engine = new FakePdfEngine();
    const a = await engine.render("<html><head><title>A</title></head></html>");
    const b = await engine.render("<html><head><title>B</title></head></html>");
    expect(Buffer.from(a.bytes).toString("binary")).not.toBe(
      Buffer.from(b.bytes).toString("binary"),
    );
  });

  it("falls back to default title when <title> missing", async () => {
    const engine = new FakePdfEngine();
    const result = await engine.render("<html><body>no title</body></html>");
    const text = Buffer.from(result.bytes).toString("binary");
    expect(text).toContain("AgentWorks Evidence Report");
  });

  it("shutdown is a no-op and idempotent", async () => {
    const engine = new FakePdfEngine();
    await engine.shutdown();
    await engine.shutdown();
  });

  it("respects format option in rendered output", async () => {
    const engine = new FakePdfEngine();
    const a4 = await engine.render("<html><head><title>X</title></head></html>", {
      format: "A4",
    });
    const text = Buffer.from(a4.bytes).toString("binary");
    expect(text).toContain("format=A4");
  });

  it("name is 'fake'", () => {
    expect(new FakePdfEngine().name).toBe("fake");
  });
});
