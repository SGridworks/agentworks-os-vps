# Codex Pre-Release Adversarial Audit

**When to use:** before tagging any AgentWorks OS release. Paste the prompt below into Codex (or any other independent LLM agent — Cursor, Claude, Gemini), point it at the candidate commit, and treat it like a hostile reviewer who gets paid only when they find a release-blocker that would embarrass you in front of a customer.

**Why this exists:** v0.1.0 → v0.1.8 had three releases in a row where a fresh customer install hit a bug we did not catch in our own dev loop. The recurring pattern: developers run inside an environment where build artifacts already exist on disk, the right ports are free, the daemon is already trained, model weights are cached, the right env vars are exported in their shell. Customers don't have any of that. An adversarial third-party agent simulating the customer surface catches what dogfooding cannot.

---

## How to run it

1. Push the candidate commit to a branch (do not tag yet).
2. Hand the prompt below to Codex with the commit SHA filled in.
3. Codex returns a numbered finding list with severity, file:line, and proposed fix.
4. You triage: BLOCKERs must be fixed before tag; HIGH/MEDIUM should be fixed unless deferred with a written reason in the CHANGELOG `Known limitations` section; LOW can ship.
5. Re-run the prompt after fixes. Stop when the only findings left are LOW or already-deferred.
6. Then tag.

---

## The prompt (copy below into Codex)

```
You are an adversarial pre-release reviewer for AgentWorks OS, an
open-source Docker-based local install. Your job is to find every bug,
documentation gap, and cross-platform portability hole that would surface
on a fresh-machine install, BEFORE the release ships. You do NOT fix
anything. You produce a numbered finding list.

Context you must have before reviewing:
- The repo at https://github.com/SGridworks/agentworks-os checked out at
  commit <FILL IN COMMIT SHA OR TAG>.
- The recent CHANGELOG entries (read at least the last 3 versions) — they
  enumerate the bug archetypes that have already shipped to customers.
- The customer install path is documented in docs/AI-AGENT-INSTALL-GUIDE.md
  and exercised by apps/installer/src/install.sh. The install must succeed
  on macOS (Apple Silicon AND Intel), Ubuntu 22.04+, and Windows 11 + WSL2
  Ubuntu, with no manual host-side build steps.

What to audit (each section is a separate pass; do all of them):

============================================================
PASS 1 — Dockerfile gitignore traps
============================================================

For every Dockerfile in the repo (find with `git ls-files '**/Dockerfile'`):
  a) For every COPY src in the Dockerfile, does that path exist in a
     fresh `git clone --depth=1 --branch <tag>`? Cross-check against
     .gitignore at the repo root and any package-level .gitignore.
     This is the v0.1.5 → v0.1.6 bug: n8n-nodes/Dockerfile COPYed
     ./packages/n8n-nodes/dist, but dist/ was gitignored, so on a clean
     clone the COPY produced "failed to compute cache key: ... not found"
     and the entire docker compose up aborted.
  b) Are EXPOSE and HEALTHCHECK port numbers consistent with the port the
     application actually binds to AND with what docker-compose.yml maps?
     The v0.1.6 → v0.1.8 bug: scanner-worker EXPOSE 8001 + healthcheck on
     :8001, but compose set SCANNER_WORKER_PORT=3101 and overrode the
     healthcheck — masked in compose, broken when run standalone.
  c) Are the runtime entrypoint's expected env vars all set somewhere
     reachable in a fresh install? (Either docker-compose.yml env, the
     installer's generated .env, or a sane default in code.) Walk the
     entrypoint script / module and grep every os.environ.get / process.env.

============================================================
PASS 2 — Cross-platform shell portability
============================================================

For apps/installer/src/install.sh, apps/installer/src/agentworks.sh,
apps/installer/scripts/smoke-test.sh, and any other .sh file in apps/:

  a) Find every grep -P / grep -oP / grep --perl-regexp. BSD grep on
     macOS does not have -P. Replace candidates with sed -nE patterns or
     awk.
  b) Find every sed -i without an empty-string argument. GNU sed accepts
     `sed -i` (no arg); BSD sed requires `sed -i ''`. Either pattern
     breaks on the other platform — only `sed -i.bak ... && rm *.bak`
     is portable.
  c) Find every readlink -f / realpath. macOS readlink does not have -f
     by default; coreutils greadlink works but is not always installed.
  d) Find every `stat -c` (GNU) or `stat -f` (BSD).
  e) Find every `mktemp` without `-d` or without a template arg — BSD
     mktemp differs.
  f) Find every `[[ -w ... ]]` against /usr/local/bin specifically — on
     Apple Silicon Macs without Homebrew, /usr/local/bin does not exist.
     Verify the fallback path works.
  g) Find every `lsof -i :<port>` — verify the fallback chain (ss,
     /dev/tcp) actually triggers on hosts without lsof.

============================================================
PASS 3 — Env-var name consistency
============================================================

For every env var the codebase reads (grep `os.environ.get` in Python,
`process.env.` in TS, `${VAR}` in bash):
  - Is the name spelled identically everywhere it is set, read, and
    documented?
  - This is the v0.1.6 → v0.1.8 bug #2: docker-compose.yml set
    SCANNER_WATCH_DIRS but the Python parser read WATCH_DIRS. Silent
    feature break for two releases.
  - Cross-check against packages/agentos-d/CLAUDE.md (which documents
    every env var the daemon reads), the installer's generated .env
    template, and docker-compose.yml.

============================================================
PASS 4 — Time-to-ready blockers
============================================================

The smoke test allows the daemon ~120s and the scanner-worker ~3s to
respond on /health. Any service whose startup blocks on a network
download (HuggingFace, npm, Docker Hub) longer than the smoke-test
timeout will produce a false WARN or FAIL.

  a) For every Python `lifespan` / `@app.on_event("startup")` and every
     Node `app.listen` / preflight task, identify any synchronous I/O
     against an external hostname.
  b) For each: how long does it take on a fresh install with cold caches?
  c) Propose either: (1) move to background task, (2) skip by default and
     require opt-in, or (3) bundle the asset into the image.
  d) The v0.1.8 fix was option (2) for embed/rerank — don't accept option
     (1) without verifying the model code handles a "not preloaded" state
     gracefully.

============================================================
PASS 5 — Documentation cross-references
============================================================

For every relative link in README.md and every file under docs/:
  a) Resolve the link target. Does the file exist in this commit?
  b) If the link includes a section anchor (#section-name or §Section),
     does that section exist?
  c) Does every `git clone --branch v0.1.X` example point at the version
     this release actually ships?
  d) The v0.1.6 → v0.1.8 bug: docs/AI-AGENT-INSTALL-GUIDE.md §2.2(B)
     pointed at docs/install-runbook.md §Vault, which never existed.

============================================================
PASS 6 — Smoke-test rigor
============================================================

apps/installer/scripts/smoke-test.sh is the install gate. Adversarially
attack it:

  a) Could any assertion give a false PASS? (e.g. `curl ... | grep -q
     "decision"` would pass on a 500 error response that happens to
     contain "decision" in the error body.)
  b) Are the timeouts realistic for a slow Docker host (WSL2 on a
     5-year-old laptop)?
  c) If a service is in `Up (unhealthy)` state per docker compose ps,
     does the smoke test catch it, or does it only assume "Up" means
     working?
  d) Does the script clean up after itself (delete the test tenant /
     test artifacts)? If not, the second run hits stale state.

============================================================
PASS 7 — Wrapper / CLI hygiene
============================================================

For apps/installer/src/agentworks.sh:
  a) Every command listed in `agentworks --help` should actually work.
     Try each one mentally end-to-end.
  b) Default values (AGENTWORKS_VERSION, etc.) should be bumped on every
     release — check whether the wrapper's defaults match the current
     CHANGELOG version.
  c) `agentworks update --check` should not lie. Run through the version
     comparison logic.
  d) `agentworks status`, `agentworks logs`, etc. should honor any custom
     port the user set at install time — not hardcode 7710 / 5678.

============================================================
PASS 8 — Compose internal consistency
============================================================

For docker-compose.yml:
  a) Every service's image: tag should equal the AGENTWORKS_VERSION
     default at the top of the file (which should equal the release
     version).
  b) Every depends_on target service should exist (and the condition
     should make sense — service_started for a non-healthcheck service
     means depends_on is essentially a no-op).
  c) Every bind-mount path on the host side should be writable by the
     container's uid (the v0.1.3 fix was chmod 777 on data/n8n and
     data/scanner; verify still in place).
  d) Every env var referenced as ${X} should either have a default
     (${X:-fallback}) or be guaranteed present in the installer's
     generated .env. List anything missing.

============================================================
PASS 9 — Release workflow vs install path
============================================================

For .github/workflows/release.yml:
  a) Does the workflow build every image referenced in docker-compose.yml
     as `image: ghcr.io/.../X:VERSION`? (admin-ui was published but never
     started in v0.1.6, that is OK; n8n is built locally per install,
     that is also OK — but flag any ghcr-referenced image with no build
     step.)
  b) Does the install.sh release-asset URL match what
     softprops/action-gh-release@v2 actually publishes?
  c) On `make GHCR packages public`, does the package list match what
     was just pushed?

============================================================
PASS 10 — Re-run / idempotency
============================================================

  a) If install.sh fails halfway and the user re-runs, does it pick up
     where it left off without losing the saved admin password?
  b) If `agentworks update` runs on a healthy stack, does it preserve
     ~/.agentworks/data and ~/.agentworks/config?
  c) If two installs collide on the same host (different AGENTWORKS_DIR
     overrides), do they share the agentos-postgres container name?
     Container names in compose are global; flag any collision risk.

============================================================
OUTPUT FORMAT
============================================================

Produce a numbered list. Each finding has exactly these fields, in this
order, no extras:

  N. file:line — SEVERITY (BLOCKER | HIGH | MEDIUM | LOW)
     Problem: <one sentence describing what is wrong>
     Repro: <the minimum command sequence a fresh-machine user would
              run that surfaces this bug — actually paste it, do not
              describe it>
     Fix: <one sentence describing the proposed fix; do not write the
           code, just say what to change and where>

Severity rubric:
  BLOCKER: a fresh-machine install on at least one supported platform
           cannot reach Smoke test PASSED, OR a feature documented
           as working in the README does not work after a clean install.
  HIGH:    a fresh-machine install reaches PASSED but a customer-visible
           feature is broken (silent feature gap, wrong default,
           misleading error message).
  MEDIUM:  works correctly on supported platforms but fragile (BSD vs
           GNU utility differences that haven't surfaced YET, race
           conditions, polish).
  LOW:     code smell with no user-visible impact.

If you find no findings in a pass, write "PASS N: clean."

Be ruthless about distinguishing "would actually break for a fresh
user" from "code I would refactor." We are shipping a product; we want
to know what breaks, not what is ugly. Skip nitpicks.

Cap output at 2000 words. If you have more than 30 findings, keep the
30 highest-severity and note "+N additional LOW findings dropped."
```

---

## What to expect

A good Codex pass returns 5-15 findings on a candidate that has had a few releases. v0.1.8's pre-release audit caught 16 items across 10 passes (3 BLOCKERS, 5 HIGH, 4 MEDIUM, 4 LOW). If Codex returns zero findings on the first run, the prompt is broken or Codex is hallucinating compliance — re-run with a different model.

A bad Codex pass returns vague "consider improving error handling" type comments. If you see those, push back: "you found nothing actionable; re-read the prompt's Severity rubric and try again, focusing on Pass N specifically."

---

## After Codex finishes

Triage the list yourself. Don't blindly fix everything Codex proposes — some "BLOCKER" findings will be false positives (it doesn't always understand the runtime context). For each finding:

- Confirm the bug exists by running the Repro yourself.
- If real and BLOCKER/HIGH: fix before tag.
- If real and MEDIUM/LOW: fix or write a one-line entry in the next CHANGELOG's `Known limitations` section deferring it.
- If false positive: ignore.

Then re-run the prompt against the post-fix commit. Iterate until the list is empty or only deferred items remain.
