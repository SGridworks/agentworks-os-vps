/**
 * PdfEngine — abstraction over an HTML-to-PDF renderer.
 *
 * Two implementations ship in this package:
 *   • PuppeteerPdfEngine — production renderer, requires Chromium on the host
 *   • FakePdfEngine      — deterministic stub for tests and dev-mode evidence
 *                          reports (returns a real PDF byte stream that opens
 *                          in any reader, without pulling Chromium)
 *
 * The choice of Puppeteer over wkhtmltopdf / weasyprint:
 *   • CSS3 + flexbox + grid + web fonts work the same as in Chrome
 *   • Headers/footers via templates with paging, page numbers, and timestamps
 *   • puppeteer-core is the dep; the customer install bundles a pinned
 *     Chromium build via @sparticuz/chromium-min or system Chrome.
 *   • wkhtmltopdf is unmaintained as of 2023; weasyprint chokes on flex/grid.
 */

import { z } from "zod";

export const PdfRenderOptionsSchema = z.object({
  format: z
    .enum(["Letter", "Legal", "A4", "A3", "Tabloid"])
    .default("Letter"),
  marginTop: z.string().default("0.75in"),
  marginBottom: z.string().default("0.75in"),
  marginLeft: z.string().default("0.75in"),
  marginRight: z.string().default("0.75in"),
  printBackground: z.boolean().default(true),
  headerTemplate: z.string().optional(),
  footerTemplate: z.string().optional(),
  displayHeaderFooter: z.boolean().default(false),
  scale: z.number().min(0.1).max(2).default(1),
  preferCSSPageSize: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(30_000),
});

export type PdfRenderOptions = z.infer<typeof PdfRenderOptionsSchema>;

export interface PdfRenderResult {
  bytes: Uint8Array;
  byteLength: number;
  contentType: "application/pdf";
  pageCount?: number;
  generatedAt: string;
}

export interface PdfEngine {
  readonly name: string;
  render(html: string, options?: Partial<PdfRenderOptions>): Promise<PdfRenderResult>;
  shutdown(): Promise<void>;
}

export class PdfEngineError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PdfEngineError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function resolveOptions(
  options?: Partial<PdfRenderOptions>,
): PdfRenderOptions {
  return PdfRenderOptionsSchema.parse(options ?? {});
}

const PDF_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

export function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_SIGNATURE.length) return false;
  for (let i = 0; i < PDF_SIGNATURE.length; i++) {
    if (bytes[i] !== PDF_SIGNATURE[i]) return false;
  }
  return true;
}
