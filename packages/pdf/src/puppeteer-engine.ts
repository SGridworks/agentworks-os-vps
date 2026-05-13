/**
 * PuppeteerPdfEngine — renders HTML with a headless Chromium via
 * puppeteer-core. Chromium is NOT bundled — the host must provide an
 * executable path (Chrome on the customer Mac mini, Chromium in the
 * docker image, or @sparticuz/chromium-min in a Lambda).
 *
 * Why puppeteer-core: it ships without the 400 MB Chromium download that
 * `puppeteer` ships with, which matters for the customer-controlled
 * install image. The customer's docker-compose provides Chromium via the
 * scanner-worker container or a dedicated headless-shell sidecar.
 *
 * The puppeteer-core package is a peer dep — agentos-d (or anyone calling
 * createPuppeteerEngine) MUST install it. The dynamic import makes test
 * environments without Chromium happy.
 */

import {
  PdfEngine,
  PdfEngineError,
  PdfRenderOptions,
  PdfRenderResult,
  resolveOptions,
} from "./engine.js";

type LaunchOptions = {
  executablePath?: string;
  args?: string[];
  headless?: boolean;
  timeout?: number;
};

type Browser = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

type Page = {
  setContent(html: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  pdf(opts: Record<string, unknown>): Promise<Buffer>;
  close(): Promise<void>;
};

type PuppeteerCoreModule = {
  launch(options?: LaunchOptions): Promise<Browser>;
};

export interface PuppeteerEngineConfig {
  /** Absolute path to Chromium / Chrome executable. */
  executablePath: string;
  /** Extra Chromium launch flags. */
  launchArgs?: string[];
  /** Hard cap on a single render. Default 30s. */
  renderTimeoutMs?: number;
  /** Override puppeteer-core import for tests. */
  puppeteerImpl?: PuppeteerCoreModule;
}

export class PuppeteerPdfEngine implements PdfEngine {
  readonly name = "puppeteer";

  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly config: PuppeteerEngineConfig) {
    if (!config.executablePath) {
      throw new PdfEngineError(
        "PuppeteerPdfEngine requires executablePath — point it at Chrome or Chromium",
      );
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browserPromise) return this.browserPromise;
    const impl = await this.loadPuppeteer();
    this.browserPromise = impl.launch({
      executablePath: this.config.executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        ...(this.config.launchArgs ?? []),
      ],
    });
    return this.browserPromise;
  }

  private async loadPuppeteer(): Promise<PuppeteerCoreModule> {
    if (this.config.puppeteerImpl) return this.config.puppeteerImpl;
    try {
      const mod = (await import("puppeteer-core")) as unknown as {
        default?: PuppeteerCoreModule;
      } & PuppeteerCoreModule;
      return mod.default ?? mod;
    } catch (err) {
      throw new PdfEngineError(
        "puppeteer-core is not installed. Add it to the host package or use FakePdfEngine.",
        err,
      );
    }
  }

  async render(
    html: string,
    options?: Partial<PdfRenderOptions>,
  ): Promise<PdfRenderResult> {
    const opts = resolveOptions(options);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, {
        waitUntil: "networkidle0",
        timeout: opts.timeoutMs,
      });
      const buffer = await page.pdf({
        format: opts.format,
        printBackground: opts.printBackground,
        displayHeaderFooter: opts.displayHeaderFooter,
        headerTemplate: opts.headerTemplate,
        footerTemplate: opts.footerTemplate,
        scale: opts.scale,
        preferCSSPageSize: opts.preferCSSPageSize,
        margin: {
          top: opts.marginTop,
          bottom: opts.marginBottom,
          left: opts.marginLeft,
          right: opts.marginRight,
        },
        timeout: opts.timeoutMs,
      });
      const bytes = new Uint8Array(buffer);
      return {
        bytes,
        byteLength: bytes.length,
        contentType: "application/pdf",
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new PdfEngineError(`puppeteer render failed: ${String(err)}`, err);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.browserPromise) return;
    const browser = await this.browserPromise;
    this.browserPromise = null;
    await browser.close();
  }
}

export function createPuppeteerEngine(
  config: PuppeteerEngineConfig,
): PuppeteerPdfEngine {
  return new PuppeteerPdfEngine(config);
}
