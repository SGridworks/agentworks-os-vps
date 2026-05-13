/**
 * Express middleware that detects the real upstream client when running behind
 * a transparent proxy and attaches `req.upstreamClient` for use in route
 * handlers, policy evaluation, and audit logging.
 *
 * Also sets `res.locals.requestId` so that structured loggers (pino-http)
 * can include the real client IP alongside the request ID in log lines.
 */

import type { Request, Response, NextFunction } from "express";
import type { UpstreamClient, TransparentProxyConfig } from "@agentworks/shared/transparent-proxy";
import { detectUpstreamClient } from "@agentworks/shared/transparent-proxy";

// Extend the Express Request type so `req.upstreamClient` is typed
declare module "express-serve-static-core" {
  interface Request {
    upstreamClient: UpstreamClient;
  }
}

export interface ProxyAwareMiddlewareOptions {
  config: TransparentProxyConfig;
}

/**
 * Create proxy-aware middleware.
 *
 * Usage:
 *   import { createProxyAwareMiddleware } from "./middleware/proxy-aware.js";
 *   app.use(createProxyAwareMiddleware({ config: defaultProxyConfig }));
 */
export function createProxyAwareMiddleware(
  options: ProxyAwareMiddlewareOptions,
) {
  const { config } = options;

  return function proxyAwareMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // remoteAddress may be IPv6 (::ffff:192.168.1.1) on some platforms — normalize to IPv4
    const remoteAddress = req.socket?.remoteAddress ?? "127.0.0.1";
    const normalizedRemoteIp = normalizeToIPv4(remoteAddress);

    const upstreamClient = detectUpstreamClient(
      req.headers as Record<string, string | string[] | undefined>,
      normalizedRemoteIp,
      config,
    );

    // Attach to request so downstream handlers can read it
    req.upstreamClient = upstreamClient;

    // Also expose via res.locals so templates / custom log serializers can access it
    res.locals.upstreamClient = upstreamClient;

    // Stamp the real client IP onto the response header so any upstream proxy
    // or load balancer that forwards to us gets the correct address.
    res.setHeader("X-Real-IP", upstreamClient.ip);

    next();
  };
}

// ---------------------------------------------------------------------------
// IPv6 normalisation (::ffff:192.168.1.1 → 192.168.1.1)
// ---------------------------------------------------------------------------

function normalizeToIPv4(ip: string): string {
  // Handle IPv6-mapped IPv4 addresses: ::ffff:192.168.1.1
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }
  return ip;
}

// ---------------------------------------------------------------------------
// Default configuration — trusts private ranges + Cloudflare
// ---------------------------------------------------------------------------

/**
 * Default trusted proxy configuration for a typical cloud deployment.
 *
 * Trusts:
 * - 10.0.0.0/8   — RFC 1918 private
 * - 172.16.0.0/12 — RFC 1918 private
 * - 192.168.0.0/16 — RFC 1918 private
 * - 100.64.0.0/10 — RFC 6598 shared address space (CGN)
 * - Cloudflare ASNs (AS13335, AS209242) — their entire IP space is trusted
 *   when CF-Connecting-IP is used, but also included here for X-Forwarded-For
 *   support behind Cloudflare in non-CF-Connecting-IP mode.
 */
export const DEFAULT_TRANSPARENT_PROXY_CONFIG: TransparentProxyConfig = {
  trustedProxyRanges: [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    // Cloudflare: AS13335 + AS209242 — all IPv4 ranges
    "103.21.244.0/22",    // CF
    "103.22.200.0/22",    // CF
    "103.31.4.0/22",      // CF
    "104.16.0.0/13",      // CF
    "104.24.0.0/14",      // CF
    "108.162.192.0/18",   // CF
    "131.0.72.0/22",      // CF
    "141.101.64.0/18",    // CF
    "162.158.0.0/15",     // CF
    "172.64.0.0/13",      // CF
    "173.245.48.0/20",    // CF
    "188.114.96.0/20",    // CF
    "190.93.240.0/20",    // CF
    "197.234.240.0/22",   // CF
    "198.41.128.0/17",    // CF
  ],
  realIpHeader: "X-Forwarded-For",
  maxProxyDepth: 4,
};
