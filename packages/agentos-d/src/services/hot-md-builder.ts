/**
 * hot-md-builder.ts — recompute per-tenant hot.md for cold-start agent reads.
 *
 * hot.md is a ~500-word curated summary that agents read before drilling
 * into specific vault keys. It is substrate-owned: written by this service,
 * not customer-writable via memory_write.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { desc, eq, and } from "drizzle-orm";
import type { VaultStore } from "@agentworks/memory";
import {
  policyDecisions,
  approvalQueue,
  tenants,
} from "../db/schema.js";
import type { Config } from "../config.js";
import { getDb } from "../db/index.js";
import { getEffectivePacksForTenant } from "../rule-pack-assignments.js";
import { loadPackFromFile } from "@agentworks/policy-engine";
import type { RulePack } from "@agentworks/shared";

const WORD_TARGET = 500;
const HOT_KEY = "hot";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface HotMdBuilderDeps {
  db: ReturnType<typeof getDb>;
  vault: VaultStore;
  tenantId: string;
  packs: readonly RulePack[];
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function truncateToWords(s: string, limit: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length <= limit) return s.trim();
  return words.slice(0, limit - 1).join(" ") + "\n\n_(truncated)_";
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : "(empty)";
}

export async function rebuildHotMd(deps: HotMdBuilderDeps): Promise<{ path: string; words: number }> {
  const { db, vault, tenantId, packs } = deps;

  // Tenant identity
  const tenant = db.select().from(tenants).where(eq(tenants.id, tenantId)).get() as
    | { id: string; name: string; description: string | null; industry: string | null }
    | undefined;

  const lines: string[] = [];
  lines.push(`# Tenant Snapshot — ${tenant?.name ?? "Unknown"}`);
  lines.push(`- **ID:** ${tenantId}`);
  if (tenant?.industry) lines.push(`- **Industry:** ${tenant.industry}`);
  lines.push("");

  // Last 10 policy decisions
  lines.push("## Recent Policy Decisions");
  const decisions = db
    .select()
    .from(policyDecisions)
    .where(eq(policyDecisions.tenantId, tenantId))
    .orderBy(desc(policyDecisions.decidedAt))
    .limit(10)
    .all() as Array<{
    decision: "allow" | "block" | "route_to_review";
    proposedActionKind: string;
    decidedAt: string;
  }>;

  if (decisions.length === 0) {
    lines.push("_No decisions yet._");
  } else {
    for (const d of decisions) {
      const time = d.decidedAt.slice(11, 16); // hh:mm
      lines.push(`- [${d.decision}] ${d.proposedActionKind} at ${time}`);
    }
  }
  lines.push("");

  // Open approvals
  lines.push("## Approval Queue");
  const openApprovals = db
    .select()
    .from(approvalQueue)
    .where(and(eq(approvalQueue.tenantId, tenantId), eq(approvalQueue.status, "pending")))
    .orderBy(approvalQueue.createdAt)
    .all() as Array<{ createdAt: string }>;

  lines.push(`- **Open:** ${openApprovals.length}`);
  if (openApprovals.length > 0) {
    const oldest = openApprovals[0]!.createdAt;
    const ageMin = Math.round((Date.now() - new Date(oldest).getTime()) / 60000);
    lines.push(`- **Oldest:** ${ageMin} min`);
  }
  lines.push("");

  // Active rule packs
  lines.push("## Active Rule Packs");
  const effective = getEffectivePacksForTenant(tenantId, packs);
  if (effective.length === 0) {
    lines.push("_None assigned._");
  } else {
    for (const p of effective) {
      lines.push(`- ${p.pack_id}`);
    }
  }
  lines.push("");

  // Vault keys (top 20 by most-recently-updated as v1 proxy for "most-read")
  lines.push("## Top Vault Keys");
  let vaultKeys: string[] = [];
  if (vault.list) {
    vaultKeys = await vault.list(tenantId);
  }
  // Exclude hot.md itself
  vaultKeys = vaultKeys.filter((k) => k !== HOT_KEY);
  const topKeys = vaultKeys.slice(0, 20);
  if (topKeys.length === 0) {
    lines.push("_No vault pages yet._");
  } else {
    for (const key of topKeys) {
      const r = await vault.read(tenantId, key);
      const summary = r.existed ? firstLine(r.body) : "(empty)";
      lines.push(`- **${key}** — ${summary}`);
    }
  }
  lines.push("");

  lines.push("_Rebuilt automatically by the substrate._");

  const fullText = lines.join("\n");
  const truncated = truncateToWords(fullText, WORD_TARGET);

  // Atomic write via vault store (uses .tmp + rename internally)
  await vault.write(tenantId, HOT_KEY, truncated, { mode: "replace" });

  return { path: join("<vault-root>", tenantId, `${HOT_KEY}.md`), words: countWords(truncated) };
}

export interface HotMdBuilderConfig {
  intervalMs?: number;
  config: Config;
}

/**
 * Start a background interval that rebuilds hot.md for every known tenant.
 * Returns a stop function. Call it on shutdown.
 */
export function startHotMdBuilder(opts: HotMdBuilderConfig): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const vaultRoot = process.env.VAULT_ROOT ?? join(process.env.HOME ?? "/tmp", "vault", "wiki");

  const packsDir = process.env.RULE_PACKS_DIR ?? join(process.cwd(), "rule-packs");
  let allPacks: RulePack[] = [];

  async function tick() {
    try {
      // Lazy-load packs on first tick
      if (allPacks.length === 0) {
        try {
          const pack = await loadPackFromFile(packsDir);
          allPacks = [pack];
        } catch {
          allPacks = [];
        }
      }

      const db = getDb();
      const { FileVaultStore } = await import("@agentworks/memory");
      const vault = new FileVaultStore({ root: vaultRoot });
      const tenantRows = db.select({ id: tenants.id }).from(tenants).all() as Array<{ id: string }>;
      for (const t of tenantRows) {
        await rebuildHotMd({ db, vault, tenantId: t.id, packs: allPacks });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[hot-md-builder] tick failed:", err);
    }
  }

  // Run immediately, then on interval
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
