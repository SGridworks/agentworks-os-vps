import type { Request, Response } from "express";
import type { Config } from "./config.js";

const STARTED_AT = new Date().toISOString();
const PACKAGE_VERSION = "0.1.0";

export function healthHandler(
  _req: Request,
  res: Response,
  config: Config,
): void {
  res.json({
    evidenceCronRunning: (global as Record<string, unknown>)["evidenceCronRunning"] ?? false,
    status: "ok",
    version: PACKAGE_VERSION,
    awcp: config.awcpVersion,
    startedAt: STARTED_AT,
    now: new Date().toISOString(),
  });
}
