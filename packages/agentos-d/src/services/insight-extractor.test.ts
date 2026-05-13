import { describe, it, expect } from "vitest";
import {
  StubInsightExtractor,
  OllamaInsightExtractor,
  AnthropicInsightExtractor,
  getInsightExtractor,
} from "./insight-extractor.js";

describe("StubInsightExtractor", () => {
  const x = new StubInsightExtractor();

  it("returns [] for empty / very short summaries", async () => {
    expect(await x.extract("")).toEqual([]);
    expect(await x.extract("ok")).toEqual([]);
  });

  it("extracts a preference clause", async () => {
    const out = await x.extract(
      "The agent ran the migration without surprises. The user prefers terse responses with no trailing summaries.",
    );
    expect(out.some((i) => i.frameType === "preference")).toBe(true);
    const pref = out.find((i) => i.frameType === "preference")!;
    expect(pref.content.toLowerCase()).toContain("terse responses");
  });

  it("extracts a constraint clause", async () => {
    const out = await x.extract(
      "Operator note: never push to main without a green CI run; always rebase first.",
    );
    expect(out.some((i) => i.frameType === "constraint")).toBe(true);
  });

  it("extracts an error_pattern clause", async () => {
    const out = await x.extract(
      "The deploy failed because the migration timed out at row 1.2M.",
    );
    expect(out.some((i) => i.frameType === "error_pattern")).toBe(true);
  });

  it("extracts a plan clause", async () => {
    const out = await x.extract("Decision: ship the redesign Friday after one more lint pass.");
    expect(out.some((i) => i.frameType === "plan")).toBe(true);
  });

  it("dedupes identical clauses across patterns", async () => {
    const out = await x.extract(
      "User prefers terse responses. User prefers terse responses. User prefers terse responses.",
    );
    const prefs = out.filter((i) => i.frameType === "preference");
    expect(prefs.length).toBe(1);
  });

  it("caps output to MAX_PER_EPISODE", async () => {
    const summary = Array(40).fill("user prefers x. user prefers y. user prefers z.").join(" ");
    const out = await x.extract(summary);
    expect(out.length).toBeLessThanOrEqual(8);
  });

  it("attaches a confidence score in [0,1] and source=agent_reflection", async () => {
    const out = await x.extract("The user prefers terse responses.");
    for (const i of out) {
      expect(i.confidence).toBeGreaterThanOrEqual(0);
      expect(i.confidence).toBeLessThanOrEqual(1);
      expect(i.source).toBe("agent_reflection");
    }
  });
});

describe("OllamaInsightExtractor", () => {
  it("returns [] when fetch errors", async () => {
    const x = new OllamaInsightExtractor({
      fetchImpl: (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
    });
    expect(await x.extract("user prefers terse responses")).toEqual([]);
  });

  it("returns [] when the model returns junk", async () => {
    const x = new OllamaInsightExtractor({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ response: "not json at all" }))) as unknown as typeof fetch,
    });
    expect(await x.extract("user prefers terse responses")).toEqual([]);
  });

  it("parses a clean JSON response into typed insights", async () => {
    const x = new OllamaInsightExtractor({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              insights: [
                {
                  frame_type: "preference",
                  subject: "voice",
                  content: "user prefers terse responses",
                  confidence: 0.9,
                },
                {
                  frame_type: "not_a_real_frame",
                  content: "should be dropped",
                  confidence: 0.9,
                },
              ],
            }),
          }),
        )) as unknown as typeof fetch,
    });
    const out = await x.extract("user prefers terse responses");
    expect(out).toHaveLength(1);
    expect(out[0]!.frameType).toBe("preference");
    expect(out[0]!.subject).toBe("voice");
  });

  it("strips markdown ```json fences", async () => {
    const fenced = "```json\n" + JSON.stringify({
      insights: [
        { frame_type: "fact", content: "the embedding model is BAAI/bge-base-en-v1.5", confidence: 0.95 },
      ],
    }) + "\n```";
    const x = new OllamaInsightExtractor({
      fetchImpl: (async () => new Response(JSON.stringify({ response: fenced }))) as unknown as typeof fetch,
    });
    const out = await x.extract("the embedding model is BAAI bge-base");
    expect(out).toHaveLength(1);
    expect(out[0]!.frameType).toBe("fact");
  });
});

describe("AnthropicInsightExtractor", () => {
  it("returns [] when no API key is configured", async () => {
    const x = new AnthropicInsightExtractor({ apiKey: "" });
    expect(await x.extract("user prefers terse responses")).toEqual([]);
  });

  it("parses a Messages API content[].text response", async () => {
    const x = new AnthropicInsightExtractor({
      apiKey: "sk-" + "test",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  insights: [
                    {
                      frame_type: "preference",
                      subject: "voice",
                      content: "terse responses",
                      confidence: 0.92,
                    },
                  ],
                }),
              },
            ],
          }),
        )) as unknown as typeof fetch,
    });
    const out = await x.extract("user prefers terse responses");
    expect(out).toHaveLength(1);
    expect(out[0]!.subject).toBe("voice");
  });
});

describe("getInsightExtractor", () => {
  it("returns stub by default", () => {
    delete process.env.INSIGHT_EXTRACTOR_BACKEND;
    expect(getInsightExtractor().name).toBe("stub");
  });

  it("respects INSIGHT_EXTRACTOR_BACKEND=ollama", () => {
    process.env.INSIGHT_EXTRACTOR_BACKEND = "ollama";
    expect(getInsightExtractor().name).toBe("ollama");
    delete process.env.INSIGHT_EXTRACTOR_BACKEND;
  });

  it("respects INSIGHT_EXTRACTOR_BACKEND=anthropic", () => {
    process.env.INSIGHT_EXTRACTOR_BACKEND = "anthropic";
    expect(getInsightExtractor().name).toBe("anthropic");
    delete process.env.INSIGHT_EXTRACTOR_BACKEND;
  });
});
