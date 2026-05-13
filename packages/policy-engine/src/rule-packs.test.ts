/**
 * Rule pack validation suite.
 *
 * Exercises every YAML rule pack shipped under rule-packs/ at the repo root.
 * Catches regressions like:
 *   - schema-breaking edits to a pack
 *   - rule field renames that silently stop matching
 *   - missing minimum metadata
 *   - target_action_kinds drift
 *
 * Two layers:
 *   1. Contract layer: every pack loads, every rule has the minimum shape.
 *      A blanket "catch any pack regression" gate.
 *   2. Smoke layer: known fixtures evaluate to known decisions. Locks the
 *      packs we ship for the pilot install — TCPA blocks a DNC SMS, fair
 *      housing routes a missing-data action, etc.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ActionEnvelope, RulePack } from "@agentworks/shared";
import { loadPackFromFile } from "./loader.js";
import { evaluatePack, evaluatePacks } from "./evaluator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULE_PACKS_DIR = resolve(HERE, "..", "..", "..", "rule-packs");

function collectPackPaths(root: string): string[] {
  const out: string[] = [];
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "test-fixtures") continue;
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...collectPackPaths(p));
    else if (/\.ya?ml$/.test(entry.name)) out.push(p);
  }
  return out;
}

async function loadAllPacks(): Promise<{ path: string; pack: RulePack }[]> {
  const paths = collectPackPaths(RULE_PACKS_DIR);
  const out: { path: string; pack: RulePack }[] = [];
  for (const p of paths) {
    out.push({ path: p, pack: await loadPackFromFile(p) });
  }
  return out;
}

function makeAction(
  actionKind: string,
  payload: Record<string, unknown> = {},
): ActionEnvelope {
  return {
    requestId: randomUUID(),
    proposedAt: new Date().toISOString(),
    tenantId: randomUUID(),
    actor: { id: "agent-test", type: "agent", label: "Test Agent" },
    actionKind,
    payload: { action_kind: actionKind, ...payload },
    context: {
      vaultRefs: [],
      conversationRefs: [],
      projectRefs: [],
      meta: { ...payload, action_kind: actionKind },
    },
    reviewed: false,
  };
}

describe("rule pack contract — every shipped pack must load and pass minimum shape", () => {
  it("at least one pack ships under rule-packs/", () => {
    const paths = collectPackPaths(RULE_PACKS_DIR);
    expect(paths.length).toBeGreaterThan(0);
  });

  it("every YAML pack loads without throwing", async () => {
    const all = await loadAllPacks();
    expect(all.length).toBeGreaterThan(0);
    for (const { path, pack } of all) {
      expect(pack, `pack at ${path} returned falsy`).toBeTruthy();
      expect(pack.pack_id, `pack_id missing at ${path}`).toMatch(/^[a-z0-9-]+$/);
      expect(pack.pack_version, `pack_version missing at ${path}`).toBeTruthy();
      expect(pack.schema_version, `schema_version missing at ${path}`).toMatch(
        /^awcp\//,
      );
      expect(pack.rules.length, `pack ${pack.pack_id} has zero rules`).toBeGreaterThan(0);
      for (const rule of pack.rules) {
        expect(rule.rule_id, `rule_id missing in ${pack.pack_id}`).toBeTruthy();
        expect(rule.name, `name missing in ${pack.pack_id}/${rule.rule_id}`).toBeTruthy();
        expect(
          rule.conditions.length,
          `${pack.pack_id}/${rule.rule_id} has zero conditions`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every pack has unique rule_ids within itself", async () => {
    const all = await loadAllPacks();
    for (const { pack } of all) {
      const ids = pack.rules.map((r) => r.rule_id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(dupes, `duplicate rule_ids in ${pack.pack_id}: ${dupes.join(",")}`).toEqual([]);
    }
  });

  it("every pack evaluates without throwing on a representative action", async () => {
    const all = await loadAllPacks();
    const action = makeAction("outbound.sms", { contact_id: "c-1" });
    for (const { pack } of all) {
      const result = evaluatePack(pack, action, false);
      expect(["allow", "block", "route_to_review"]).toContain(result.decision);
      expect(typeof result.reason).toBe("string");
    }
  });

  it("every pack with target_action_kinds lists only lowercase dot-separated kinds", async () => {
    const all = await loadAllPacks();
    const re = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
    for (const { pack } of all) {
      if (!pack.target_action_kinds) continue;
      for (const k of pack.target_action_kinds) {
        expect(k, `bad target_action_kind in ${pack.pack_id}: ${k}`).toMatch(re);
      }
    }
  });
});

describe("rule pack smoke — locked decisions for the pilot-install matrix", () => {
  it("TCPA real-estate pack blocks a DNC SMS with full evidence", async () => {
    const path = join(
      RULE_PACKS_DIR,
      "tcpa-real-estate",
      "tcpa-real-estate-v0.1.yaml",
    );
    const pack = await loadPackFromFile(path);
    const action = makeAction("outbound.sms", {
      phone_number: "+15555550100",
      consent_status: "no_consent",
      dnc_status: true,
      calling_time_local: "10:00",
    });
    const result = evaluatePack(pack, action, false);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toMatch(/^TCPA-RE-/);
  });

  it("Fair Housing pack routes a housing action with missing protected-class evidence", async () => {
    const path = join(
      RULE_PACKS_DIR,
      "fair-housing",
      "fair-housing-v0.1.yaml",
    );
    const pack = await loadPackFromFile(path);
    const action = makeAction("outbound.sms", { housing_related: true });
    const result = evaluatePack(pack, action, false);
    expect(["block", "route_to_review"]).toContain(result.decision);
  });

  it("severity-aware aggregation: TCPA block beats Fair Housing route_to_review", async () => {
    const tcpa = await loadPackFromFile(
      join(RULE_PACKS_DIR, "tcpa-real-estate", "tcpa-real-estate-v0.1.yaml"),
    );
    const fh = await loadPackFromFile(
      join(RULE_PACKS_DIR, "fair-housing", "fair-housing-v0.1.yaml"),
    );
    // Fair Housing list first to prove severity wins, not order.
    const result = evaluatePacks(
      [fh, tcpa],
      makeAction("outbound.sms", {
        phone_number: "+15555550100",
        consent_status: "no_consent",
        dnc_status: true,
        calling_time_local: "10:00",
      }),
      false,
    );
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toMatch(/^TCPA-RE-/);
  });

  it("smb-starter pack returns a determinate decision on lead.generation", async () => {
    const path = join(
      RULE_PACKS_DIR,
      "smb-starter",
      "smb-starter-v0.1.yaml",
    );
    const pack = await loadPackFromFile(path);
    const result = evaluatePack(pack, makeAction("lead.generation"), false);
    expect(["allow", "block", "route_to_review"]).toContain(result.decision);
  });
});
