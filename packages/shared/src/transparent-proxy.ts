/**
 * RFC — Transparent Proxy Detection
 *
 * Detects the real client (IP, port, user-agent) from upstream proxy headers
 * when running behind a transparent proxy (Cloudflare, AWS ALB, nginx, etc.).
 *
 * Security model:
 * - We ONLY trust X-Forwarded-For / X-Real-IP / CF-Connecting-IP when the
 *   immediate connection (remoteIp) comes from a trusted proxy range.
 * - This prevents IP spoofing: an untrusted client cannot inject a fake
 *   X-Forwarded-For to masquerade as another user.
 * - The first _untrusted_ IP in the X-Forwarded-For chain is treated as
 *   the real client; all preceding entries are trusted proxies.
 */

import { isIPv4 } from "net";

export interface UpstreamClient {
  ip: string; // Real client IP
  port: number; // Real client port
  userAgent?: string; // User-Agent header
  via?: string; // Via header (proxy chain)
  forwardedFor?: string[]; // X-Forwarded-For chain
}

export interface TransparentProxyConfig {
  /** Trust these IP ranges as proxies (CIDR notation, IPv4 only) */
  trustedProxyRanges: string[];
  /**
   * Header to read real IP from if trusted proxy detected.
   * - X-Forwarded-For: comma-separated list, leftmost = original client
   * - X-Real-IP: single IP set by nginx
   * - CF-Connecting-IP: Cloudflare-provided real IP (only set when
   *   Cloudflare can determine the true client, i.e. not a cached response)
   */
  realIpHeader: "X-Forwarded-For" | "X-Real-IP" | "CF-Connecting-IP";
  /** Maximum proxy chain depth to trust (prevents deep-chain spoofing) */
  maxProxyDepth: number;
}

// ---------------------------------------------------------------------------
// CIDR matching (IPv4 only)
// ---------------------------------------------------------------------------

/** Parse a IPv4 CIDR string into a base number and bitmask. */
function parseCIDR(cidr: string): { base: number; mask: number } | null {
  const parts = cidr.split("/");
  if (parts.length !== 2) return null;
  const ip = parts[0];
  const bits = parseInt(parts[1], 10);
  if (!isIPv4(ip) || isNaN(bits) || bits < 0 || bits > 32) return null;
  const octets = ip.split(".").map(Number);
  const base =
    ((octets[0] << 24) |
      (octets[1] << 16) |
      (octets[2] << 8) |
      octets[3]) >>>
    0;
  const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0;
  return { base, mask };
}

/** Check whether an IPv4 address falls within a CIDR range. */
function ipInCIDR(ip: string, cidr: string): boolean {
  if (!isIPv4(ip)) return false;
  const parsed = parseCIDR(cidr);
  if (!parsed) return false;
  const octets = ip.split(".").map(Number);
  const ipNum =
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>>
    0;
  return (ipNum & parsed.mask) === (parsed.base & parsed.mask);
}

/** Check whether an IP is in any of the trusted proxy ranges. */
function isTrustedProxy(ip: string, trustedRanges: string[]): boolean {
  return trustedRanges.some((range) => ipInCIDR(ip, range));
}

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

function getSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const val = headers[key.toLowerCase()];
  if (Array.isArray(val)) return val[0];
  return val;
}

function getListHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string[] {
  const val = headers[key.toLowerCase()];
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  return val.split(",").map((s) => s.trim());
}

/**
 * Validate that a string looks like a plausible IPv4 address.
 * Rejects strings with special characters, leading/trailing whitespace, etc.
 * to prevent request smuggling via malformed X-Forwarded-For values.
 */
function looksLikeIPv4(s: string): boolean {
  return isIPv4(s) && s === s.trim() && s === s.replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Core detection logic
// ---------------------------------------------------------------------------

export function detectUpstreamClient(
  headers: Record<string, string | string[] | undefined>,
  remoteIp: string,
  config: TransparentProxyConfig,
): UpstreamClient {
  const userAgent = getSingleHeader(headers, "user-agent");
  const via = getSingleHeader(headers, "via");

  // If the immediate connection is NOT from a trusted proxy, use it directly.
  // Do NOT honour any X-Forwarded-For etc. from an untrusted client.
  if (!isTrustedProxy(remoteIp, config.trustedProxyRanges)) {
    return {
      ip: remoteIp,
      port: 0, // Direct connections expose no port at the HTTP layer
      userAgent,
      via,
      forwardedFor: undefined,
    };
  }

  // Trusted proxy — parse the configured realIpHeader
  switch (config.realIpHeader) {
    case "X-Forwarded-For": {
      const chain = getListHeader(headers, "x-forwarded-for");
      const validChain: string[] = [];

      for (const entry of chain) {
        if (!looksLikeIPv4(entry)) break; // Malformed entry — stop parsing
        if (validChain.length >= config.maxProxyDepth) break; // Chain too deep

        if (isTrustedProxy(entry, config.trustedProxyRanges)) {
          validChain.push(entry); // Trusted proxy, keep traversing
        } else {
          // First untrusted IP is the real client
          validChain.push(entry);
          return {
            ip: entry,
            port: 0,
            userAgent,
            via,
            forwardedFor: chain.length > 0 ? chain : undefined,
          };
        }
      }

      // All entries in X-Forwarded-For were trusted proxies (chain exhausted).
      // Fall back to remoteIp (the last trusted proxy).
      return {
        ip: remoteIp,
        port: 0,
        userAgent,
        via,
        forwardedFor: chain.length > 0 ? chain : undefined,
      };
    }

    case "X-Real-IP": {
      const realIp = getSingleHeader(headers, "x-real-ip");
      if (realIp && looksLikeIPv4(realIp)) {
        return { ip: realIp, port: 0, userAgent, via, forwardedFor: undefined };
      }
      // Malformed or missing X-Real-IP — fall back to remoteIp
      return { ip: remoteIp, port: 0, userAgent, via, forwardedFor: undefined };
    }

    case "CF-Connecting-IP": {
      const cfIp = getSingleHeader(headers, "cf-connecting-ip");
      if (cfIp && looksLikeIPv4(cfIp)) {
        return { ip: cfIp, port: 0, userAgent, via, forwardedFor: undefined };
      }
      // Malformed or missing CF-Connecting-IP — fall back to remoteIp
      return { ip: remoteIp, port: 0, userAgent, via, forwardedFor: undefined };
    }
  }
}
