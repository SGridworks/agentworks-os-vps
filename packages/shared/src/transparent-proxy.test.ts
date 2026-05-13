import { describe, it, expect } from "vitest";
import { detectUpstreamClient } from "./transparent-proxy.js";
import type { TransparentProxyConfig } from "./transparent-proxy.js";

// ---------------------------------------------------------------------------
// Shared config helpers
// ---------------------------------------------------------------------------

const PRIVATE_CONFIG: TransparentProxyConfig = {
  trustedProxyRanges: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  realIpHeader: "X-Forwarded-For",
  maxProxyDepth: 4,
};

const CF_CONFIG: TransparentProxyConfig = {
  trustedProxyRanges: [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    // Simplified Cloudflare range for tests
    "103.21.244.0/22",
    "172.64.0.0/13",
    "198.41.128.0/17",
  ],
  realIpHeader: "CF-Connecting-IP",
  maxProxyDepth: 4,
};

const XFF_CONFIG: TransparentProxyConfig = {
  trustedProxyRanges: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  realIpHeader: "X-Forwarded-For",
  maxProxyDepth: 2,
};

function headers(
  overrides: Record<string, string | undefined>,
): Record<string, string | string[] | undefined> {
  return { ...overrides };
}

function emptyHeaders(): Record<string, string | string[] | undefined> {
  return {};
}

// ---------------------------------------------------------------------------
// Direct connections (no proxy)
// ---------------------------------------------------------------------------

describe("direct connection — no proxy headers", () => {
  it("returns remoteIp as client IP when no proxy headers are present", () => {
    const result = detectUpstreamClient(
      emptyHeaders(),
      "203.0.113.50",
      PRIVATE_CONFIG,
    );
    expect(result.ip).toBe("203.0.113.50");
    expect(result.port).toBe(0);
    expect(result.forwardedFor).toBeUndefined();
  });

  it("returns remoteIp even if X-Forwarded-For is present from untrusted client", () => {
    const h = headers({
      "x-forwarded-for": "10.0.0.5, 10.0.0.4",
    });
    // remoteIp is NOT in trusted range — must not honour XFF
    const result = detectUpstreamClient(h, "203.0.113.50", PRIVATE_CONFIG);
    expect(result.ip).toBe("203.0.113.50");
    expect(result.forwardedFor).toBeUndefined();
  });

  it("passes through user-agent and via even for direct connections", () => {
    const h = headers({
      "user-agent": "TestClient/1.0",
      via: "1.1 my-proxy",
    });
    const result = detectUpstreamClient(h, "198.51.100.10", PRIVATE_CONFIG);
    expect(result.ip).toBe("198.51.100.10");
    expect(result.userAgent).toBe("TestClient/1.0");
    expect(result.via).toBe("1.1 my-proxy");
  });
});

// ---------------------------------------------------------------------------
// X-Forwarded-For from trusted proxy
// ---------------------------------------------------------------------------

describe("X-Forwarded-For from trusted proxy", () => {
  it("returns the first IP in X-Forwarded-For as real client", () => {
    const h = headers({
      "x-forwarded-for": "203.0.113.1, 10.0.0.5, 10.0.0.4",
      "user-agent": "Mozilla/5.0",
    });
    // remoteIp (10.0.0.5) is trusted proxy
    const result = detectUpstreamClient(h, "10.0.0.5", PRIVATE_CONFIG);
    expect(result.ip).toBe("203.0.113.1");
    expect(result.userAgent).toBe("Mozilla/5.0");
    expect(result.forwardedFor).toEqual([
      "203.0.113.1",
      "10.0.0.5",
      "10.0.0.4",
    ]);
  });

  it("returns second IP when first is also trusted proxy", () => {
    const h = headers({
      "x-forwarded-for": "10.0.0.99, 10.0.0.5, 10.0.0.4",
    });
    const result = detectUpstreamClient(h, "10.0.0.5", PRIVATE_CONFIG);
    // First untrusted IP (or chain exhausted) → real client is last trusted
    // In this case: 10.0.0.99 is trusted, 10.0.0.5 is trusted,
    // XFF is exhausted, so we fall back to remoteIp (10.0.0.5)
    expect(result.ip).toBe("10.0.0.5");
  });

  it("handles single-value X-Forwarded-For", () => {
    const h = headers({
      "x-forwarded-for": "203.0.113.200",
    });
    const result = detectUpstreamClient(h, "10.0.0.5", PRIVATE_CONFIG);
    expect(result.ip).toBe("203.0.113.200");
  });
});

// ---------------------------------------------------------------------------
// X-Forwarded-For from UNtrusted IP (spoofing prevention)
// ---------------------------------------------------------------------------

describe("X-Forwarded-For spoofing prevention", () => {
  it("ignores X-Forwarded-For when remoteIp is not in trusted ranges", () => {
    const h = headers({
      "x-forwarded-for": "203.0.113.1, 10.0.0.5",
    });
    // remoteIp 8.8.8.8 is NOT trusted
    const result = detectUpstreamClient(h, "8.8.8.8", PRIVATE_CONFIG);
    expect(result.ip).toBe("8.8.8.8");
    expect(result.forwardedFor).toBeUndefined();
  });

  it("ignores spoofed X-Forwarded-For sent by an untrusted public IP", () => {
    // Attacker tries to fake their IP as 1.2.3.4 via XFF
    const h = headers({
      "x-forwarded-for": "1.2.3.4",
    });
    const result = detectUpstreamClient(h, "203.0.113.99", PRIVATE_CONFIG);
    // We never honour XFF from an untrusted sender
    expect(result.ip).toBe("203.0.113.99");
  });

  it("rejects malformed X-Forwarded-For entries (stops parsing)", () => {
    const h = headers({
      // 10.0.0.5 is trusted, then invalid entry, then real client
      "x-forwarded-for": "10.0.0.5, not-an-ip, 203.0.113.1",
    });
    const result = detectUpstreamClient(h, "10.0.0.5", PRIVATE_CONFIG);
    // Parsing stops at "not-an-ip" (not a valid IPv4)
    // Chain is exhausted (no untrusted IP found), falls back to remoteIp
    expect(result.ip).toBe("10.0.0.5");
  });

  it("rejects entries with whitespace that is not a valid IP", () => {
    const h = headers({
      // After split+trim: ["10.0.0.5", "not-an-ip", "203.0.113.1"]
      // "not-an-ip" is invalid → chain exhausted → fallback to remoteIp
      "x-forwarded-for": "10.0.0.5, not-an-ip, 203.0.113.1",
    });
    const result = detectUpstreamClient(h, "10.0.0.5", PRIVATE_CONFIG);
    // Parsing stops at "not-an-ip" (not a valid IPv4)
    // Chain is exhausted (no untrusted IP found), falls back to remoteIp
    expect(result.ip).toBe("10.0.0.5");
  });
});

// ---------------------------------------------------------------------------
// CF-Connecting-IP (Cloudflare)
// ---------------------------------------------------------------------------

describe("CF-Connecting-IP (Cloudflare)", () => {
  it("extracts real IP from CF-Connecting-IP", () => {
    const h = headers({
      "cf-connecting-ip": "203.0.113.55",
      "user-agent": "Cloudflare-App",
    });
    const result = detectUpstreamClient(h, "172.64.0.1", CF_CONFIG);
    expect(result.ip).toBe("203.0.113.55");
  });

  it("falls back to remoteIp when CF-Connecting-IP is missing", () => {
    const h = headers({});
    const result = detectUpstreamClient(h, "172.64.0.1", CF_CONFIG);
    expect(result.ip).toBe("172.64.0.1");
  });

  it("ignores CF-Connecting-IP from untrusted IP", () => {
    const h = headers({
      "cf-connecting-ip": "203.0.113.55",
    });
    // 8.8.8.8 is not a trusted proxy
    const result = detectUpstreamClient(h, "8.8.8.8", CF_CONFIG);
    expect(result.ip).toBe("8.8.8.8");
  });

  it("rejects malformed CF-Connecting-IP", () => {
    const h = headers({
      "cf-connecting-ip": "not-an-ip",
    });
    const result = detectUpstreamClient(h, "172.64.0.1", CF_CONFIG);
    expect(result.ip).toBe("172.64.0.1"); // Falls back to remoteIp
  });
});

// ---------------------------------------------------------------------------
// Chained proxies / maxProxyDepth
// ---------------------------------------------------------------------------

describe("chained proxies — maxProxyDepth enforcement", () => {
  it("first untrusted IP in chain is the real client even with short maxProxyDepth", () => {
    const h = headers({
      // Chain: 203.0.113.1 (untrusted) → 10.0.0.5 (trusted) → 10.0.0.4 (trusted)
      "x-forwarded-for": "203.0.113.1, 10.0.0.5, 10.0.0.4",
    });
    const result = detectUpstreamClient(h, "10.0.0.5", XFF_CONFIG);
    // First untrusted IP (203.0.113.1) is the real client
    expect(result.ip).toBe("203.0.113.1");
  });

  it("falls back to remoteIp when XFF chain is all trusted proxies", () => {
    const h = headers({
      // All entries are trusted proxies
      "x-forwarded-for": "10.0.0.99, 10.0.0.5, 10.0.0.4",
    });
    const result = detectUpstreamClient(h, "10.0.0.5", XFF_CONFIG);
    // All trusted → fallback to remoteIp (last trusted proxy)
    expect(result.ip).toBe("10.0.0.5");
  });
});

// ---------------------------------------------------------------------------
// X-Real-IP header
// ---------------------------------------------------------------------------

describe("X-Real-IP", () => {
  const config: TransparentProxyConfig = {
    trustedProxyRanges: ["10.0.0.0/8"],
    realIpHeader: "X-Real-IP",
    maxProxyDepth: 4,
  };

  it("returns X-Real-IP when set by trusted proxy", () => {
    const h = headers({ "x-real-ip": "203.0.113.77" });
    const result = detectUpstreamClient(h, "10.0.0.5", config);
    expect(result.ip).toBe("203.0.113.77");
  });

  it("ignores X-Real-IP from untrusted remoteIp", () => {
    const h = headers({ "x-real-ip": "203.0.113.77" });
    const result = detectUpstreamClient(h, "8.8.8.8", config);
    expect(result.ip).toBe("8.8.8.8");
  });

  it("falls back to remoteIp when X-Real-IP is absent", () => {
    const h = headers({});
    const result = detectUpstreamClient(h, "10.0.0.5", config);
    expect(result.ip).toBe("10.0.0.5");
  });

  it("rejects malformed X-Real-IP", () => {
    const h = headers({ "x-real-ip": "not-ipv4" });
    const result = detectUpstreamClient(h, "10.0.0.5", config);
    expect(result.ip).toBe("10.0.0.5");
  });
});

// ---------------------------------------------------------------------------
// IPv6 / ::ffff: normalisation
// ---------------------------------------------------------------------------

describe("IPv6 normalisation", () => {
  it("handles plain IPv4 addresses correctly", () => {
    const h = headers({});
    const result = detectUpstreamClient(h, "192.168.1.100", PRIVATE_CONFIG);
    expect(result.ip).toBe("192.168.1.100");
  });

  it("::ffff: prefix must be normalised by the middleware before calling detectUpstreamClient", () => {
    const h = headers({});
    // detectUpstreamClient itself does NOT handle ::ffff: — it must be
    // normalised by the Express middleware layer first.
    // Here we verify the input passes through unchanged (middleware must pre-normalise).
    const result = detectUpstreamClient(h, "::ffff:192.168.1.100", PRIVATE_CONFIG);
    // isIPv4("::ffff:192.168.1.100") is false → not treated as trusted proxy
    // remoteIp is used as-is.
    expect(result.ip).toBe("::ffff:192.168.1.100");
  });
});

// ---------------------------------------------------------------------------
// Via header
// ---------------------------------------------------------------------------

describe("Via header passthrough", () => {
  it("captures the Via header when present", () => {
    const h = headers({
      via: "1.1 my-reverse-proxy, 1.0 internal-lb",
      "x-forwarded-for": "203.0.113.1",
    });
    const result = detectUpstreamClient(h, "10.0.0.5", PRIVATE_CONFIG);
    expect(result.via).toBe("1.1 my-reverse-proxy, 1.0 internal-lb");
  });
});
