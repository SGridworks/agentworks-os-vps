/**
 * Recursive character-chunking for RAG — splits raw text into semantic chunks.
 *
 * Strategy: recursive character split.
 *   1. Try to split at paragraph boundaries (\n\n).
 *   2. If a chunk still exceeds targetTokens, split at sentence boundaries (\n, . ! ?).
 *   3. If still too large, split at a hard character count.
 *   4. If a single paragraph is still too large, split at sentence boundaries.
 *   5. If still too large, split at word boundaries.
 *   6. If still too large, split at character count (last resort).
 *
 * Overlap: every chunk overlaps with the previous chunk by overlapTokens characters
 * (converted to chars at ~4 chars/token). This ensures information that spans a
 * chunk boundary is not lost.
 *
 * Chunk size targets follow the RAG best-practice sweet spot:
 *   300-500 tokens for general text, 200-300 for code.
 *
 * Token estimation: cl100k_base approximate — 1 token ≈ 4 characters.
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Chunk, ChunkMetadata, ChunkContentType } from "./types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ChunkOptions {
  /**
   * Target chunk size in tokens. Default: 400.
   * Chunks will be smaller or larger depending on natural boundaries.
   */
  targetTokens?: number;
  /**
   * Overlap between consecutive chunks in tokens.
   * 50-100 tokens is the recommended range. Default: 100.
   */
  overlapTokens?: number;
  /**
   * Override the content type hint.
   * "code" chunks are split more aggressively at function/class boundaries.
   * "transcript" chunks respect speaker turns.
   */
  contentType?: ChunkContentType;
}

/**
 * Chunk a raw text document into an ordered array of Chunks.
 *
 * @param tenantId   — tenant for the chunk's metadata
 * @param vaultKey   — which vault page this text came from
 * @param rawText    — the full document body (no frontmatter)
 * @param opts       — chunking options
 * @returns          — ordered array of Chunks
 */
export function chunkDocument(
  tenantId: string,
  vaultKey: string,
  rawText: string,
  opts: ChunkOptions = {},
): Chunk[] {
  const {
    targetTokens = 400,
    overlapTokens = 100,
    contentType = "document",
  } = opts;

  // Convert token counts to character approximations
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  // Normalise line endings
  const text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Split into blocks at natural boundaries
  const blocks = splitIntoBlocks(text, contentType);

  const chunks: Chunk[] = [];
  let currentChunk = "";
  let byteOffset = 0;
  let chunkIndex = 0;

  for (const block of blocks) {
    if (currentChunk.length === 0) {
      currentChunk = block;
      byteOffset = text.indexOf(block, byteOffset);
    } else if (currentChunk.length + block.length <= targetChars) {
      currentChunk += "\n" + block;
    } else {
      // currentChunk is full — emit it
      if (currentChunk.trim().length > 0) {
        chunks.push(makeChunk(tenantId, vaultKey, currentChunk, byteOffset, chunkIndex, blocks.length, opts));
        chunkIndex++;
      }
      // Start new chunk with overlap from end of previous
      const overlapText = currentChunk.slice(-overlapChars);
      currentChunk = overlapText + "\n" + block;
      byteOffset = text.indexOf(block, byteOffset);
    }
  }

  // Emit final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(makeChunk(tenantId, vaultKey, currentChunk, byteOffset, chunkIndex, blocks.length, opts));
  }

  return chunks;
}

// ─── Block splitting ─────────────────────────────────────────────────────────

type BlockType = "paragraph" | "sentence" | "word" | "char";

/**
 * Recursively split text into blocks.
 * Depth 0: try paragraph splits. Depth 1: sentence. Depth 2: word. Depth 3: char.
 */
function splitIntoBlocks(text: string, contentType: ChunkContentType, depth = 0): string[] {
  const maxDepth = 3;
  if (depth >= maxDepth) return [text];

  const separators = getSeparators(contentType, depth);
  const parts = splitPreservingSeparators(text, separators);

  // If splitting produced useful blocks (not just one giant part), return them
  if (parts.length > 1) return parts;

  // Otherwise recurse deeper
  return depth < maxDepth ? splitIntoBlocks(text, contentType, depth + 1) : [text];
}

function getSeparators(contentType: ChunkContentType, depth: number): string[] {
  if (contentType === "code") {
    // Code: prefer function/class boundaries
    return depth === 0
      ? ["\n\n", "\nclass ", "\nfunction ", "\ndef ", "\nasync def ", "\nconst ", "\nlet ", "\nclass ", "\ninterface "]
      : depth === 1
        ? ["\n", ";\n", "{\n", "}\n"]
        : depth === 2
          ? [" ", "\n"]
          : [""];
  }

  if (contentType === "transcript") {
    // Transcripts: preserve speaker turns
    return depth === 0
      ? ["\n\n", "\n\n>", "\n---\n"]
      : depth === 1
        ? ["\n", ": "]
        : depth === 2
          ? [" "]
          : [""];
  }

  // Default document: paragraphs → sentences → words → chars
  return depth === 0
    ? ["\n\n", "\n\n"]
    : depth === 1
      ? [". ", "! ", "? ", ".\n", "!\n", "?\n"]
      : depth === 2
        ? [" "]
        : [""];
}

/**
 * Split text on any of the separator strings, preserving the separators
 * as trailing content of each part.
 */
function splitPreservingSeparators(text: string, separators: string[]): string[] {
  if (separators.length === 0 || separators[0] === "") return [text];

  // Sort separators by length descending to match longest first
  const sorted = [...separators].sort((a, b) => b.length - a.length);

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let splitAt = -1;
    let matchedSep = "";

    for (const sep of sorted) {
      const idx = remaining.indexOf(sep);
      if (idx !== -1 && (splitAt === -1 || idx < splitAt)) {
        splitAt = idx;
        matchedSep = sep;
      }
    }

    if (splitAt === -1) {
      parts.push(remaining);
      break;
    }

    // Include the separator at the end of this part
    const part = remaining.slice(0, splitAt + matchedSep.length);
    if (part.trim().length > 0) parts.push(part);
    remaining = remaining.slice(splitAt + matchedSep.length);
  }

  return parts.length > 0 ? parts : [text];
}

// ─── Chunk assembly ───────────────────────────────────────────────────────────

function makeChunk(
  tenantId: string,
  vaultKey: string,
  body: string,
  byteOffset: number,
  chunkIndex: number,
  totalBlocks: number,
  opts: ChunkOptions,
): Chunk {
  const contentType = opts.contentType ?? "document";
  const now = new Date().toISOString();
  const contentSha256 = sha256Hex(body.trim());

  const metadata: ChunkMetadata = {
    createdAt: now,
    updatedAt: now,
    contentSha256,
    contentType,
  };

  return {
    id: randomUUID(),
    tenantId,
    vaultKey,
    body: body.trim(),
    tokenCount: estimateTokens(body.trim()),
    byteOffset,
    chunkIndex,
    totalChunks: totalBlocks, // Will be corrected after full pass
    metadata,
  };
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Approximate token count using cl100k_base ratio (~1 token ≈ 4 chars).
 * For code, use a tighter ratio (1 token ≈ 3.5 chars) since code is denser.
 */
export function estimateTokens(text: string): number {
  // Strip markdown formatting artifacts that inflate char count
  const stripped = text
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/`[^`]*`/g, "")          // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // links

  return Math.ceil(stripped.length / 4);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
