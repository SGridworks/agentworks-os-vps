import { describe, it, expect } from "vitest";
import {
  verifyPdfSignature,
  REVOKED_KEY_IDS,
} from "./evidence-report-signing.js";

describe("evidence-report signing — key revocation", () => {
  it("includes the leaked v1 keyId in REVOKED_KEY_IDS", () => {
    expect(REVOKED_KEY_IDS.has("bed588cd")).toBe(true);
  });

  it("rejects a signature claiming a revoked keyId before any other check", () => {
    // The leaked secret could be used by a third party to mint a forged
    // signature whose HMAC actually validates. Revocation must therefore
    // fire on keyId alone, before HMAC verification, so a forgery from
    // the leaked key is rejected even when the hash checks would pass.
    const pdf = Buffer.from("%PDF-1.4\nfake\n%%EOF\n");
    const sig = {
      alg: "HS256",
      pdfHash: "0".repeat(64),
      reportId: "r",
      ts: "2026-05-03T00:00:00.000Z",
      keyId: "bed588cd",
    };
    const trailer = `\n<!--sig-->${JSON.stringify(sig)}<!--sig-->\n`;
    const tampered = Buffer.concat([pdf, Buffer.from(trailer, "utf8")]);

    expect(() => verifyPdfSignature(tampered)).toThrow(/revoked/i);
  });
});
