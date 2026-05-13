# AI Agent Vault Hygiene Guide

**Audience:** an AI coding agent the operator has tasked with cleaning, organizing, or maintaining the AgentWorks OS vault.

**Operator hand-off:** *"clean up the vault"*, *"lint the vault"*, *"the vault is getting messy"*, *"audit what's in here."*

**Companion docs:**
- [docs/users-guide.md §6](./users-guide.md) — the manual operator guide for vault organization
- [docs/best-practices.md "Vault Hygiene"](./best-practices.md) — operating norms

This file is operational: a six-stage cleanup loop with verifications, decision points, and explicit "don't touch this" rules.

**Target version:** v0.1.1.

---

## How to read this guide

The vault is the operator's working memory and the substrate's grounding context for every agent that runs against this tenant. A bad cleanup pass can:

- Delete pages the operator was actively editing
- Rewrite frontmatter that downstream tooling depends on
- Break `[[wikilinks]]` that the policy engine, scanner, or evidence report cite
- Strip provenance that compliance review depends on

So:

1. **Always run §1 inventory and §2 backup before §3 onward.** Non-negotiable.
2. **Never delete a file in one pass.** §6 has a stage-and-confirm flow — use it.
3. **Decisions** are explicit. The operator decides what's "complete" or "stale" — your job is to surface candidates with evidence, not to judge.
4. **Don't touch operator-private subtrees.** §0 lists them. They contain memory the operator has marked private to the agent's auto-memory system or to themselves.
5. **Stop and ask** before: deleting more than ~10 files in one batch, rewriting frontmatter on more than ~20 files, moving anything across the wiki/memory/raw-sources boundary, modifying anything inside `_archive/`, anything inside `.obsidian/`, or anything matching `*.private.md`.

---

## §0 — Off-limits

Do not modify, move, rename, or delete files matching any of these patterns without explicit per-file operator approval:

| Pattern | Why off-limits |
|---|---|
| `**/*.private.md` | Marked private by convention. |
| `**/_archive/**` | The operator chose to keep these. |
| `**/.obsidian/**` | Obsidian's own state — your edits will fight the app. |
| `**/.gstack/**`, `**/.paperclip/**` | Tool-state directories from companion systems. |
| `raw-sources/**` | Immutable source documents. The wiki summarizes these; the originals never change. |
| `memory/MEMORY.md` | Index file maintained by the auto-memory system. Other agents will fight your edits. |
| Any file whose frontmatter contains `lifecycle: archived` | Already retired by a consolidation pass. |

If a cleanup task seems to require touching one of these, **stop and ask** the operator: *"the cleanup needs to touch <path> which is marked off-limits — do you want to grant a one-time exception, or should I work around it?"*

---

## §1 — Inventory

Run before any cleanup. Capture a snapshot of where the vault is right now.

### 1.1 Tenant scope

```bash
TENANT_ID=$(grep -o '"id":"[^"]*"' $HOME/.agentworks/data/tenant-bootstrap.json 2>/dev/null | head -1 | cut -d\" -f4)
VAULT_DIR=$(docker compose -f $HOME/.agentworks/docker-compose.yml exec -T agentos-d env 2>/dev/null | grep VAULT_ROOT | cut -d= -f2 | tr -d '\r')
VAULT_DIR=${VAULT_DIR:-$HOME/vault/wiki}
echo "Tenant:  $TENANT_ID"
echo "Vault:   $VAULT_DIR/$TENANT_ID/"
ls -la "$VAULT_DIR/$TENANT_ID/" | head -30
```

**Verify:** the tenant directory exists. If it doesn't, the operator has nothing to clean — confirm you're on the right host.

### 1.2 Counts

```bash
cd "$VAULT_DIR/$TENANT_ID"
echo "Total .md files:       $(find . -type f -name '*.md' | wc -l)"
echo "Symlinked subdirs:     $(find . -maxdepth 2 -type l | wc -l)"
echo "Largest 10 files:"
find . -type f -name '*.md' -exec ls -l {} \; | sort -k5 -n | tail -10
echo
echo "Top-level layout:"
ls -F | head -40
```

### 1.3 Vault graph (the daemon's view)

```bash
curl -sS "http://127.0.0.1:7710/api/memory/graph?tenantId=$TENANT_ID" | \
  python3 -c "
import json, sys
g = json.load(sys.stdin)
nodes = g.get('nodes', [])
edges = g.get('edges', [])
print(f'graph: {len(nodes)} nodes, {len(edges)} edges')
# top-degree nodes
from collections import Counter
deg = Counter()
for e in edges: deg[e.get('source')] += 1; deg[e.get('target')] += 1
for n, d in deg.most_common(10): print(f'  {d:4d}  {n}')
"
```

### 1.4 Snapshot

Save this inventory to a temp file — you'll diff against it after cleanup:

```bash
find "$VAULT_DIR/$TENANT_ID" -type f -name '*.md' | sort > /tmp/vault-before-$(date +%s).txt
wc -l /tmp/vault-before-*.txt | tail -1
```

---

## §2 — Backup

Cleanup creates the possibility of accidental deletion. Take a backup of the vault directory:

```bash
BACKUP_DIR="$HOME/.agentworks/data/backups"
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/vault-prelint-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C "$VAULT_DIR" "$TENANT_ID"
ls -lh "$BACKUP_DIR"/vault-prelint-*.tar.gz | tail -1
```

**Verify:** the tarball exists and isn't suspiciously small.

Also take a daemon-DB backup so any reference-cleanup that touches DB-backed data can be rolled back:

```bash
docker compose -f $HOME/.agentworks/docker-compose.yml exec -T agentos-d \
  agentos backup --output /app/data/backups/vault-prelint-$(date +%Y%m%d-%H%M%S).tar.gz
```

**Hard rule:** if either backup fails, do not proceed. Surface to the operator.

---

## §3 — Lint

Find candidate problems. Don't fix them yet — just enumerate.

### 3.1 Frontmatter audit

Every page should have YAML frontmatter with at least `title`, `created`, `updated`. Find pages without:

```bash
cd "$VAULT_DIR/$TENANT_ID"
for f in $(find . -name '*.md' -not -path '*/_archive/*'); do
  head -1 "$f" | grep -q '^---$' || echo "NO-FRONTMATTER: $f"
done > /tmp/vault-no-fm.txt
wc -l /tmp/vault-no-fm.txt
head /tmp/vault-no-fm.txt
```

### 3.2 Stale `updated:` dates

Pages whose body has been edited recently but `updated:` field hasn't changed:

```bash
for f in $(find . -name '*.md' -newer /tmp/vault-before-*.txt 2>/dev/null); do
  fmupdated=$(grep -m1 '^updated:' "$f" | cut -d: -f2- | tr -d ' "')
  filemtime=$(stat -f '%Sm' -t '%Y-%m-%d' "$f" 2>/dev/null || stat -c '%y' "$f" | cut -d' ' -f1)
  if [ -n "$fmupdated" ] && [ "$fmupdated" != "$filemtime" ]; then
    echo "STALE-UPDATED: $f  fm=$fmupdated  file=$filemtime"
  fi
done > /tmp/vault-stale-updated.txt
wc -l /tmp/vault-stale-updated.txt
```

### 3.3 Broken wikilinks

```bash
python3 - <<'EOF' "$VAULT_DIR/$TENANT_ID"
import os, re, sys
root = sys.argv[1]
all_pages = set()
for dp, _, fs in os.walk(root):
    for f in fs:
        if f.endswith('.md'):
            rel = os.path.relpath(os.path.join(dp, f), root).removesuffix('.md')
            all_pages.add(rel)
            all_pages.add(os.path.basename(rel))  # bare-name match
broken = []
for dp, _, fs in os.walk(root):
    for f in fs:
        if not f.endswith('.md'): continue
        p = os.path.join(dp, f)
        try: txt = open(p, encoding='utf-8').read()
        except UnicodeDecodeError: continue
        for m in re.finditer(r'\[\[([^\]]+?)\]\]', txt):
            target = m.group(1).split('|')[0].split('#')[0]
            if target not in all_pages:
                broken.append((os.path.relpath(p, root), target))
for src, tgt in broken[:50]:
    print(f"BROKEN-LINK: {src}  ->  [[{tgt}]]")
print(f"...total broken: {len(broken)}")
EOF
```

### 3.4 Orphan pages

Pages with zero inbound `[[wikilinks]]`:

```bash
python3 - <<'EOF' "$VAULT_DIR/$TENANT_ID"
import os, re, sys
root = sys.argv[1]
pages = {}
for dp, _, fs in os.walk(root):
    for f in fs:
        if f.endswith('.md'):
            rel = os.path.relpath(os.path.join(dp, f), root).removesuffix('.md')
            pages[rel] = 0
for dp, _, fs in os.walk(root):
    for f in fs:
        if not f.endswith('.md'): continue
        try: txt = open(os.path.join(dp, f), encoding='utf-8').read()
        except UnicodeDecodeError: continue
        for m in re.finditer(r'\[\[([^\]]+?)\]\]', txt):
            t = m.group(1).split('|')[0].split('#')[0]
            for k in pages:
                if k == t or os.path.basename(k) == t:
                    pages[k] += 1
                    break
for k, v in sorted(pages.items()):
    if v == 0:
        print(f"ORPHAN: {k}")
EOF
```

Orphans are not automatically bad — `index.md`, `README.md`, hot caches, and meta files are intentionally inbound-link-free. Use judgment.

### 3.5 Duplicate-content candidates

Pages with very similar names or substantial body overlap:

```bash
# Similar filenames (Levenshtein-cheap version: same prefix or stem)
cd "$VAULT_DIR/$TENANT_ID"
find . -name '*.md' -printf '%f\n' 2>/dev/null | sort | \
  awk -F. '{stem=$1; gsub(/-v[0-9]+$|-old$|-copy[0-9]*$/, "", stem); print stem}' | \
  sort | uniq -c | awk '$1 > 1 { print "DUPE-NAME: " $0 }' | head -20
```

```bash
# Body overlap (cheap word-set Jaccard against last page)
# Manual review — list the 20 most recently modified .md files for the operator to scan:
ls -lt $(find . -name '*.md') 2>/dev/null | head -20
```

### 3.6 Stale claims

Look for absolute dates in bodies that may be obsolete:

```bash
# Pages last modified > 90 days ago that contain words like "current", "ongoing", "active"
find . -name '*.md' -mtime +90 2>/dev/null | xargs grep -lE '\b(current(ly)?|ongoing|active|in progress|WIP|TODO)\b' 2>/dev/null | head -20
```

### 3.7 Compile lint report

```bash
{
  echo "# Vault Lint Report — $(date)"
  echo ""
  echo "## Counts"
  echo "- Total pages: $(find "$VAULT_DIR/$TENANT_ID" -name '*.md' | wc -l)"
  echo "- No frontmatter: $(wc -l < /tmp/vault-no-fm.txt)"
  echo "- Stale updated: $(wc -l < /tmp/vault-stale-updated.txt)"
  # ... etc
} > /tmp/vault-lint-report.md
cat /tmp/vault-lint-report.md
```

This is your input to §4.

---

## §4 — Decision: scope of the cleanup

Before fixing anything, surface the lint report and ask:

> *"Lint pass found:
> - <N> pages without frontmatter
> - <N> pages with stale `updated:` dates
> - <N> broken wikilinks pointing at deleted pages
> - <N> orphan pages (probably mostly fine — index/meta files)
> - <N> duplicate-name candidates
> - <N> pages > 90 days old still claiming 'active' state
>
> Which of these do you want me to fix in this pass? Default suggestion: frontmatter + stale-updated (low risk, mechanical), surface the others as a list for you to review."*

The operator picks the scope. Don't go beyond it.

---

## §5 — Fix (mechanical changes)

Only the categories the operator approved in §4. Apply in order.

### 5.1 Add missing frontmatter

For each `NO-FRONTMATTER` page from §3.1:

```bash
# Show what would change first — diff dry-run:
for f in $(head /tmp/vault-no-fm.txt | sed 's/NO-FRONTMATTER: //'); do
  echo "--- $f ---"
  echo "would prepend:"
  cat <<EOF
---
title: $(basename "$f" .md | tr - ' ' | sed 's/.*/\u&/')
created: $(stat -f '%SB' -t '%Y-%m-%d' "$f" 2>/dev/null || stat -c '%y' "$f" | cut -d' ' -f1)
updated: $(date +%Y-%m-%d)
---

EOF
done
```

Show the operator the dry-run output. Only after they say "go," apply the change for real. Use a script that is idempotent — running it twice should not double-prepend.

### 5.2 Fix stale `updated:` dates

```bash
# For each STALE-UPDATED page, set updated: to file mtime:
for line in $(cat /tmp/vault-stale-updated.txt); do
  f=$(echo "$line" | awk '{print $2}')
  # ... show diff first, apply only with operator approval
done
```

### 5.3 Broken wikilinks

Two valid fixes per broken link:

1. **Link target moved or renamed:** find the new path with `git log --diff-filter=R` (if vault is git-tracked) and update the link.
2. **Link target genuinely deleted:** remove the link or replace with plain text.

**Do NOT silently delete bracketed text** — the operator may have intended to write the page later. Default action: leave the broken link, but emit a list to a file the operator reviews:

```bash
mv /tmp/vault-broken-links.txt "$VAULT_DIR/$TENANT_ID/_lint-output/broken-links-$(date +%Y%m%d).md"
```

### 5.4 Don't auto-merge duplicates

Even if two pages obviously cover the same topic, **do not auto-merge**. Surface the candidate pair and ask:

> *"`<page-a>.md` and `<page-b>.md` look like the same topic. Want me to merge into <page-a> and add a redirect note in <page-b>, or are they actually different?"*

---

## §6 — Stage-and-confirm for deletions

If the operator approves deleting any pages (orphans, archived, duplicates):

### 6.1 Move to a trash subdir, don't `rm`

```bash
TRASH="$VAULT_DIR/$TENANT_ID/_trash-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TRASH"
for f in <list of approved deletions>; do
  mkdir -p "$TRASH/$(dirname "$f")"
  mv "$VAULT_DIR/$TENANT_ID/$f" "$TRASH/$f"
done
ls -R "$TRASH" | head -30
```

The trash directory stays in the tenant's vault subtree, so it's still backed up and auditable. Tell the operator:

> *"<N> pages moved to `_trash-YYYYMMDD-HHMMSS/` instead of deleted. They'll show up in normal backups but are out of the active context. After you've reviewed and confirmed, you can delete the trash dir manually with `rm -rf <path>`. I won't do that step."*

### 6.2 Update graph

After moves, rebuild the graph so the daemon's view matches reality:

```bash
curl -sS -X POST "http://127.0.0.1:7710/api/memory/graph/rebuild?tenantId=$TENANT_ID" | head -c 200
```

---

## §7 — Verify

After cleanup, confirm nothing broke.

### 7.1 Diff against pre-cleanup snapshot

```bash
find "$VAULT_DIR/$TENANT_ID" -type f -name '*.md' -not -path '*/_trash-*/*' | sort > /tmp/vault-after.txt
diff /tmp/vault-before-*.txt /tmp/vault-after.txt | head -50
```

The diff should match what you intended:
- Pages you intentionally trashed appear with `<` (removed).
- Pages with new frontmatter still appear (paths unchanged).
- No surprise additions or removals.

### 7.2 Daemon graph still parses

```bash
curl -sS "http://127.0.0.1:7710/api/memory/graph?tenantId=$TENANT_ID" | \
  python3 -c "import json,sys; g=json.load(sys.stdin); print(f'nodes:{len(g[\"nodes\"])} edges:{len(g[\"edges\"])}')"
```

Compare against §1.3's count. The number should match (with adjustments for what you deliberately moved).

### 7.3 Spot-check a high-value page

Pick one or two of the operator's most-referenced pages (top of §1.3's degree list) and read them top to bottom. Frontmatter sane? Body intact? `[[wikilinks]]` still resolve?

```bash
head -20 "$VAULT_DIR/$TENANT_ID/<top-page>.md"
```

---

## §8 — Final report

```
Vault hygiene pass — <date>

Tenant:           <UUID>
Vault path:       <VAULT_DIR/TENANT_ID>
Pages before:     <N>
Pages after:      <N>  (delta = +<adds> / -<moves to trash>)
Backups:          <vault-prelint-...tar.gz path>, <DB backup path>

Lint findings (snapshot):
  No frontmatter:    <N>  → <fixed:M / surfaced:M-fixed>
  Stale updated:     <N>  → <fixed / surfaced>
  Broken wikilinks:  <N>  → <fixed:M / surfaced as report>
  Orphan pages:      <N>  → <surfaced; defaulted to no action>
  Duplicates:        <N>  → <surfaced as candidate pairs>
  Stale claims:      <N>  → <surfaced as list>

Changes made:
  - <each mechanical fix, with file count>
  - <if you moved any files to trash, list count + path>

NOT done (waiting on operator):
  - <each surface-only finding the operator hasn't decided yet>

What you should do next:
  1. Review _trash-<timestamp>/ — delete with `rm -rf` if you confirm none are needed
  2. Review <broken-links-report-path> — fix or accept
  3. Review duplicate-pair list and decide merges
  4. <anything else>

Verifications passed:
  [✓] §7.1 file diff matches intent
  [✓] §7.2 graph nodes/edges count consistent
  [✓] §7.3 spot-check page intact
```

---

## Reference: what good vault hygiene looks like

(From [docs/best-practices.md](./best-practices.md), summarized for the agent's reference.)

- One concept per page. Split rather than grow past ~300 lines.
- Frontmatter on every page: `title`, `tags`, `created`, `updated`, optional `sources`.
- Cross-link with `[[wikilinks]]`. The graph relies on these.
- Don't duplicate raw-source content into the wiki — link to the source page.
- Review and prune monthly: `Action-Tracker.md`, `log.md` rotation, `wiki/projects/_archive/` for completed projects.
- Never put credentials, full SSNs, or PHI into vault pages — vault is not a secrets store.

---

## See also

- [docs/users-guide.md](./users-guide.md) §6 "Vault Guide", §12 "Routine Maintenance"
- [docs/best-practices.md](./best-practices.md) "Vault Hygiene"
- [docs/AI-AGENT-INSTALL-GUIDE.md](./AI-AGENT-INSTALL-GUIDE.md) §8 "Vault setup"
- [docs/AI-AGENT-OPERATOR-RUNBOOK.md](./AI-AGENT-OPERATOR-RUNBOOK.md) — adjacent ops tasks
