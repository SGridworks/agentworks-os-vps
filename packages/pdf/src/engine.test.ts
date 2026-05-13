/**
 * engine contract tests.
 *
 *   - resolveOptions fills defaults
 *   - resolveOptions rejects bad scale / format / margins
 *   - isPdfBytes recognises the %PDF signature
 *   - PdfEngineError preserves cause
 */

import { describe, it, expect } from "vitest";
import {
  resolveOptions,
  isPdfBytes,
  PdfEngineError,
  PdfRenderOptionsSchema,
} from "./engine.js";

describe("resolveOptions", () => {
  it("fills defaults when nothing provided", () => {
    const r = resolveOptions();
    expect(r.format).toBe("Letter");
    expect(r.printBackground).toBe(true);
    expect(r.scale).toBe(1);
    expect(r.timeoutMs).toBe(30_000);
    expect(r.marginTop).toBe("0.75in");
  });

  it("respects explicit overrides", () => {
    const r = resolveOptions({ format: "A4", scale: 0.8, marginTop: "1in" });
    expect(r.format).toBe("A4");
    expect(r.scale).toBe(0.8);
    expect(r.marginTop).toBe("1in");
  });

  it("rejects scale outside [0.1, 2]", () => {
    expect(() => resolveOptions({ scale: 0.05 })).toThrow();
    expect(() => resolveOptions({ scale: 2.5 })).toThrow();
  });

  it("rejects unknown format", () => {
    expect(() =>
      PdfRenderOptionsSchema.parse({ format: "Postcard" }),
    ).toThrow();
  });

  it("rejects negative timeout", () => {
    expect(() => resolveOptions({ timeoutMs: -100 })).toThrow();
  });
});

describe("isPdfBytes", () => {
  it("recognises a real PDF header", () => {
    const bytes = new Uint8Array(Buffer.from("%PDF-1.4\nrest", "binary"));
    expect(isPdfBytes(bytes)).toBe(true);
  });

  it("rejects non-PDF content", () => {
    expect(isPdfBytes(new Uint8Array(Buffer.from("hello", "utf8")))).toBe(false);
    expect(isPdfBytes(new Uint8Array([0x25, 0x50, 0x44]))).toBe(false);
    expect(isPdfBytes(new Uint8Array(0))).toBe(false);
  });
});

describe("PdfEngineError", () => {
  it("preserves cause", () => {
    const cause = new Error("boom");
    const e = new PdfEngineError("rendering failed", cause);
    expect(e.message).toBe("rendering failed");
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("PdfEngineError");
  });
});
