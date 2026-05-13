import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

vi.mock("./db/index.js", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    run: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue({ count: 0 }),
  };
  return { getDb: () => mockDb };
});

const TENANT = "11111111-1111-1111-1111-111111111111";

describe("DEBUG circuit-state", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(loadConfig({}));
  });

  it("debug circuit-state", async () => {
    const res = await request(app)
      .get("/api/proxy/circuit-state")
      .query({ provider: "openai", tenantId: TENANT });
    console.log("STATUS:", res.status);
    console.log("BODY:", JSON.stringify(res.body));
    expect(res.status).toBe(200);
  });
});
