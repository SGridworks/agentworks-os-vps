import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";

const STARTED_AT = new Date().toISOString();

// Resolve at startup from package.json so /api/health reports the version
// of the daemon that's actually running, not a stale hardcoded constant.
function resolvePackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "package.json"),
      join(here, "..", "..", "package.json"),
    ];
    for (const path of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "@agentworks/agentos-d" && pkg.version) return pkg.version;
      } catch {
        // try next candidate
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
}

const PACKAGE_VERSION = resolvePackageVersion();

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
