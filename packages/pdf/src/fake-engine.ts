/**
 * FakePdfEngine — deterministic, dependency-free engine that returns a real,
 * minimal valid PDF document. Used for tests and dev-mode evidence reports
 * where pulling Chromium is unwanted.
 *
 * The output is a 1-page PDF rendering the input HTML title and a hash of the
 * body. It opens in any PDF reader. This is NOT a substitute for real
 * rendering — it exists so that endpoints depending on PdfEngine can be
 * exercised end-to-end without Chromium.
 */

import { createHash } from "node:crypto";
import {
  PdfEngine,
  PdfRenderOptions,
  PdfRenderResult,
  resolveOptions,
} from "./engine.js";

export class FakePdfEngine implements PdfEngine {
  readonly name = "fake";

  async render(
    html: string,
    options?: Partial<PdfRenderOptions>,
  ): Promise<PdfRenderResult> {
    const opts = resolveOptions(options);
    const titleMatch = /<title>([^<]*)<\/title>/i.exec(html);
    const title = titleMatch?.[1]?.trim() ?? "AgentWorks Evidence Report";
    const hash = createHash("sha256").update(html).digest("hex").slice(0, 16);
    const bytes = buildMinimalPdf({ title, hash, format: opts.format });
    return {
      bytes,
      byteLength: bytes.length,
      contentType: "application/pdf",
      pageCount: 1,
      generatedAt: new Date().toISOString(),
    };
  }

  async shutdown(): Promise<void> {
    // no resources to release
  }
}

function buildMinimalPdf(meta: {
  title: string;
  hash: string;
  format: string;
}): Uint8Array {
  // Hand-rolled minimal PDF (single page, Helvetica). This is the smallest
  // structurally valid PDF that opens in macOS Preview, Acrobat, and
  // Chrome's built-in viewer.
  const safeTitle = meta.title.replace(/[\\()]/g, "").slice(0, 64);
  const stream = [
    "BT",
    "/F1 24 Tf",
    "1 0 0 1 72 720 Tm",
    `(${safeTitle}) Tj`,
    "0 -36 Td",
    "/F1 10 Tf",
    `(fake-engine sha256=${meta.hash}) Tj`,
    "0 -18 Td",
    `(format=${meta.format}) Tj`,
    "ET",
  ].join("\n");

  const objects: string[] = [];
  const xref: number[] = [];
  let pos = 0;
  const header = "%PDF-1.4\n%âãÏÓ\n";
  pos += Buffer.byteLength(header, "binary");

  function pushObj(s: string): void {
    xref.push(pos);
    objects.push(s);
    pos += Buffer.byteLength(s, "binary");
  }

  pushObj("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  pushObj("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  pushObj(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
  );
  const streamObj =
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "binary")} >>\n` +
    `stream\n${stream}\nendstream\nendobj\n`;
  pushObj(streamObj);
  pushObj("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  const xrefStart = pos;
  let xrefTable = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of xref) {
    xrefTable += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF`;

  const full = header + objects.join("") + xrefTable + trailer;
  return new Uint8Array(Buffer.from(full, "binary"));
}
