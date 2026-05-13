/**
 * Insight extractor — phase 1b follow-up.
 *
 * Takes an episode summary and produces zero or more atomic frame-typed
 * insights. Pluggable backend: stub (heuristic, no LLM dep), ollama
 * (local LLM via /api/generate), or anthropic (cloud API).
 *
 * Wired as fire-and-forget after recordEpisode in episode-from-run.ts.
 *
 * Backend selection (env INSIGHT_EXTRACTOR_BACKEND):
 *   - "stub"      (default) — regex-driven, no external dep
 *   - "ollama"    — POST {base}/api/generate with a fixed extraction
 *                   prompt; reads OLLAMA_BASE_URL + OLLAMA_EXTRACTOR_MODEL
 *   - "anthropic" — Anthropic Messages API; reads ANTHROPIC_API_KEY +
 *                   ANTHROPIC_EXTRACTOR_MODEL (default claude-haiku-4-5)
 *
 * The interface is intentionally narrow: an extractor sees only the
 * episode summary text and returns a list of (frameType, subject?,
 * content, confidence) tuples. The caller decides what to record.
 */

import type { FrameType, InsightSource } from "./insights.js";

export interface ExtractedInsight {
  frameType: FrameType;
  subject: string | null;
  content: string;
  /** 0–1 — caller can threshold to drop low-confidence extractions. */
  confidence: number;
  /** Source attribution to write through to recordInsight. */
  source: InsightSource;
}

export interface InsightExtractor {
  readonly name: string;
  extract(
    summary: string,
    ctx: { tenantId: string; episodeId: string },
  ): Promise<ExtractedInsight[]>;
}

// ---------------------------------------------------------------------------
// Stub: regex-driven heuristic extractor. Crude but dep-free.
// ---------------------------------------------------------------------------

interface StubPattern {
  re: RegExp;
  frameType: FrameType;
  /** Confidence floor — patterns vary in precision. */
  confidence: number;
  /** Extract a subject from match groups (or null). */
  subjectFn?: (m: RegExpMatchArray) => string | null;
}

// Patterns are deliberately conservative to keep stub-extracted noise low.
// Each pattern looks for a specific clause shape and extracts the matched
// sentence as the insight content. Future LLM backends will do better.
const STUB_PATTERNS: StubPattern[] = [
  {
    // "user prefers/likes/wants X", "operator chose X"
    re: /\b(?:user|operator)\s+(?:prefers|likes|wants|chose|picked|requested|asked for)\s+([^.;\n]{3,160})/gi,
    frameType: "preference",
    confidence: 0.55,
    subjectFn: (m) => (m[1] ?? "").trim().split(/\s+/).slice(0, 3).join(" ") || null,
  },
  {
    // "must X", "always X", "never X" — constraint cues
    re: /\b(?:must|always|never|cannot|do not|don't)\s+([^.;\n]{3,160})/gi,
    frameType: "constraint",
    confidence: 0.4,
  },
  {
    // failure / error language → error_pattern frame
    re: /\b(?:failed|errored|crashed|broke|threw|timed out|timeout|404|500)\b[^.;\n]{0,160}/gi,
    frameType: "error_pattern",
    confidence: 0.5,
  },
  {
    // explicit decisions / plans
    re: /\b(?:decided|decision:|plan(?:ning)? to|will\s+\w+|next step)\s+([^.;\n]{3,160})/gi,
    frameType: "plan",
    confidence: 0.45,
  },
];

const MIN_CONFIDENCE = 0.4;
const MAX_PER_EPISODE = 8;

export class StubInsightExtractor implements InsightExtractor {
  readonly name = "stub";
  // eslint-disable-next-line @typescript-eslint/require-await
  async extract(summary: string): Promise<ExtractedInsight[]> {
    if (!summary || summary.trim().length < 10) return [];
    const out: ExtractedInsight[] = [];
    const seen = new Set<string>();
    for (const p of STUB_PATTERNS) {
      // Reset regex state between runs (global flag carries lastIndex)
      p.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = p.re.exec(summary)) !== null) {
        const content = match[0].trim();
        const key = `${p.frameType}::${content.toLowerCase()}`;
        if (seen.has(key)) continue;
        if (content.length < 8) continue;
        seen.add(key);
        out.push({
          frameType: p.frameType,
          subject: p.subjectFn ? p.subjectFn(match) : null,
          content,
          confidence: p.confidence,
          source: "agent_reflection",
        });
        if (out.length >= MAX_PER_EPISODE) return out;
      }
    }
    return out.filter((i) => i.confidence >= MIN_CONFIDENCE);
  }
}

// ---------------------------------------------------------------------------
// Ollama backend: POST {base}/api/generate with a constrained JSON prompt.
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You read agent task summaries and extract atomic memory frames.

Output STRICT JSON: {"insights": [{"frame_type": "...", "subject": "...", "content": "...", "confidence": 0.0}]}

Frame types: preference | fact | plan | constraint | feedback | error_pattern.
Each insight must be one short clause (5-30 words). subject is the entity it's about, or null.
confidence is 0.0-1.0. Skip anything you're not confident about. Cap at 6 insights.
Return only JSON, no prose, no markdown.

Summary:
"""{SUMMARY}"""`;

interface ExtractorJsonShape {
  insights?: Array<{
    frame_type?: string;
    subject?: string | null;
    content?: string;
    confidence?: number;
  }>;
}

const VALID_FRAMES: FrameType[] = [
  "preference",
  "fact",
  "plan",
  "constraint",
  "feedback",
  "error_pattern",
];

function parseExtractorJson(raw: string): ExtractedInsight[] {
  const trimmed = raw.trim();
  // Some LLMs wrap output in ```json fences — strip them.
  const stripped = trimmed.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed: ExtractorJsonShape;
  try {
    parsed = JSON.parse(stripped) as ExtractorJsonShape;
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.insights)) return [];
  const out: ExtractedInsight[] = [];
  for (const r of parsed.insights) {
    const frame = (r.frame_type ?? "").toLowerCase().trim() as FrameType;
    if (!VALID_FRAMES.includes(frame)) continue;
    const content = (r.content ?? "").trim();
    if (content.length < 5 || content.length > 600) continue;
    const confidence = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
    out.push({
      frameType: frame,
      subject: typeof r.subject === "string" && r.subject.length > 0 ? r.subject : null,
      content,
      confidence,
      source: "agent_reflection",
    });
    if (out.length >= MAX_PER_EPISODE) break;
  }
  return out.filter((i) => i.confidence >= MIN_CONFIDENCE);
}

export class OllamaInsightExtractor implements InsightExtractor {
  readonly name = "ollama";
  constructor(
    private readonly opts: {
      baseUrl?: string;
      model?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async extract(summary: string): Promise<ExtractedInsight[]> {
    if (!summary || summary.trim().length < 10) return [];
    const baseUrl = (this.opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = this.opts.model ?? process.env.OLLAMA_EXTRACTOR_MODEL ?? "gemma3:4b";
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: EXTRACTION_PROMPT.replace("{SUMMARY}", summary.slice(0, 6000)),
          stream: false,
          format: "json",
        }),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { response?: string };
      return parseExtractorJson(body.response ?? "");
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic backend: Messages API with a small Haiku model by default.
// ---------------------------------------------------------------------------

export class AnthropicInsightExtractor implements InsightExtractor {
  readonly name = "anthropic";
  constructor(
    private readonly opts: {
      apiKey?: string;
      model?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async extract(summary: string): Promise<ExtractedInsight[]> {
    if (!summary || summary.trim().length < 10) return [];
    const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return [];
    const model = this.opts.model ?? process.env.ANTHROPIC_EXTRACTOR_MODEL ?? "claude-haiku-4-5";
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: EXTRACTION_PROMPT.replace("{SUMMARY}", summary.slice(0, 8000)) }],
        }),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      return parseExtractorJson(text);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getInsightExtractor(): InsightExtractor {
  const backend = (process.env.INSIGHT_EXTRACTOR_BACKEND ?? "stub").toLowerCase().trim();
  switch (backend) {
    case "ollama":
      return new OllamaInsightExtractor();
    case "anthropic":
      return new AnthropicInsightExtractor();
    case "stub":
    default:
      return new StubInsightExtractor();
  }
}
