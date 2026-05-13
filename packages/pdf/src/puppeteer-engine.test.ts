/**
 * PuppeteerPdfEngine tests — exercise the engine with an injected fake
 * puppeteer-core implementation. We never launch real Chromium here.
 *
 *   - rejects construction without executablePath
 *   - reuses a single browser across renders
 *   - passes format / margins / printBackground to page.pdf()
 *   - tags output as application/pdf
 *   - shutdown closes the browser; second shutdown is a no-op
 *   - render rethrows page errors as PdfEngineError
 */

import { describe, it, expect, vi } from "vitest";
import { PuppeteerPdfEngine } from "./puppeteer-engine.js";
import { PdfEngineError } from "./engine.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\nfake pdf\n%%EOF", "binary");

function makeFakePuppeteer(opts?: {
  pdfThrows?: Error;
  setContentThrows?: Error;
}) {
  const pageClose = vi.fn(async () => {});
  const setContent = vi.fn(async () => {
    if (opts?.setContentThrows) throw opts.setContentThrows;
  });
  const pdf = vi.fn(async (_o: Record<string, unknown>) => {
    if (opts?.pdfThrows) throw opts.pdfThrows;
    return PDF_BYTES;
  });
  const newPage = vi.fn(async () => ({ setContent, pdf, close: pageClose }));
  const close = vi.fn(async () => {});
  const launch = vi.fn(async () => ({ newPage, close }));
  return { launch: { launch }, calls: { newPage, pdf, setContent, pageClose, close } };
}

describe("PuppeteerPdfEngine", () => {
  it("rejects construction without executablePath", () => {
    expect(() => new PuppeteerPdfEngine({ executablePath: "" })).toThrow(
      PdfEngineError,
    );
  });

  it("reuses one browser across multiple renders", async () => {
    const fake = makeFakePuppeteer();
    const engine = new PuppeteerPdfEngine({
      executablePath: "/fake/chrome",
      puppeteerImpl: fake.launch,
    });
    await engine.render("<html><body>1</body></html>");
    await engine.render("<html><body>2</body></html>");
    expect(fake.launch.launch).toHaveBeenCalledTimes(1);
    expect(fake.calls.newPage).toHaveBeenCalledTimes(2);
  });

  it("passes format, margins, and printBackground through to page.pdf", async () => {
    const fake = makeFakePuppeteer();
    const engine = new PuppeteerPdfEngine({
      executablePath: "/fake/chrome",
      puppeteerImpl: fake.launch,
    });
    await engine.render("<html><body>x</body></html>", {
      format: "A4",
      marginTop: "1in",
      marginBottom: "1in",
      marginLeft: "0.5in",
      marginRight: "0.5in",
      printBackground: false,
    });
    const pdfArg = fake.calls.pdf.mock.calls[0]?.[0];
    expect(pdfArg).toBeDefined();
    expect(pdfArg).toMatchObject({
      format: "A4",
      printBackground: false,
      margin: {
        top: "1in",
        bottom: "1in",
        left: "0.5in",
        right: "0.5in",
      },
    });
  });

  it("returns application/pdf with byteLength matching bytes", async () => {
    const fake = makeFakePuppeteer();
    const engine = new PuppeteerPdfEngine({
      executablePath: "/fake/chrome",
      puppeteerImpl: fake.launch,
    });
    const result = await engine.render("<html></html>");
    expect(result.contentType).toBe("application/pdf");
    expect(result.byteLength).toBe(result.bytes.length);
    expect(result.byteLength).toBe(PDF_BYTES.length);
    expect(result.generatedAt).toMatch(/^\d{4}-/);
  });

  it("closes the page even when rendering fails", async () => {
    const fake = makeFakePuppeteer({ pdfThrows: new Error("Chromium crashed") });
    const engine = new PuppeteerPdfEngine({
      executablePath: "/fake/chrome",
      puppeteerImpl: fake.launch,
    });
    await expect(engine.render("<html></html>")).rejects.toThrow(PdfEngineError);
    expect(fake.calls.pageClose).toHaveBeenCalled();
  });

  it("wraps setContent failures as PdfEngineError", async () => {
    const fake = makeFakePuppeteer({
      setContentThrows: new Error("net::ERR_FAILED"),
    });
    const engine = new PuppeteerPdfEngine({
      executablePath: "/fake/chrome",
      puppeteerImpl: fake.launch,
    });
    await expect(engine.render("<html></html>")).rejects.toThrow(PdfEngineError);
  });

  it("shutdown closes the browser and is idempotent", async () => {
    const fake = makeFakePuppeteer();
    const engine = new PuppeteerPdfEngine({
      executablePath: "/fake/chrome",
      puppeteerImpl: fake.launch,
    });
    await engine.render("<html></html>");
    await engine.shutdown();
    expect(fake.calls.close).toHaveBeenCalledTimes(1);
    await engine.shutdown(); // no-op
    expect(fake.calls.close).toHaveBeenCalledTimes(1);
  });

  it("name is 'puppeteer'", () => {
    const fake = makeFakePuppeteer();
    const engine = new PuppeteerPdfEngine({
      executablePath: "/fake/chrome",
      puppeteerImpl: fake.launch,
    });
    expect(engine.name).toBe("puppeteer");
  });
});
