# Codex v0.1.9 Release-Readiness Go/No-Go

**When to use:** once the v0.1.9 candidate is on `main` (all 7 v0.1.9 milestone items closed: PR #7 merged, issues #8–#13 fixed) and you are ready to tag. Run from the repo root:

```
cd /path/to/agentworks-os
codex exec - < docs/CODEX-V019-GO-NOGO.md
```

…or interactive:

```
codex -C /path/to/agentworks-os
> [paste the prompt section below]
```

**Why this exists:** v0.1.8 took two cancelled workflow runs, three workflow rewrites, four PRs, and an external pilot install before it actually shipped. Dogfooding misses fresh-install bugs. Codex review of the diff misses behavioral bugs. This prompt is an adversarial **pre-tag rehearsal** — walk the install path under each persona, verify every commitment in the v0.1.9 milestone landed, and return a binary GO or NO-GO. No fixes. Evidence-based decision only.

---

## Prompt to paste into Codex

> You are doing a release-readiness audit on AgentWorks OS for the v0.1.9 tag. This is **not a code review**. It is a binary **go/no-go** decision. The maintainer is tired of iterating after public releases. Your only goal is to find anything that would force a v0.1.9.1 within a week, before the tag goes out.
>
> **Repo:** `SGridworks/agentworks-os-vps` (public)
> **Candidate commit:** `<CANDIDATE_SHA>` on `main`
> **v0.1.9 milestone:** https://github.com/SGridworks/agentworks-os-vps/milestone/1
>
> **Process rules:**
> - Do not propose fixes. Report findings only.
> - If `<CANDIDATE_SHA>` is still a placeholder, mark the candidate identity row UNKNOWN and return NO-GO. This audit must be tied to one exact commit.
> - Anything ambiguous → NO-GO until clarified. Tie goes to the maintainer's sleep.
> - "We test in CI" is not evidence. Run-or-walk-the-actual-bytes is evidence. Cite line numbers.
> - "It works on my machine" failure modes are exactly what this audit is designed to catch. Treat the maintainer's local env as suspect — they have cached artifacts, exported env vars, free ports, and warm Docker layers that customers do not.
> - Do not trust issue, PR, or milestone status as proof of behavior. Use GitHub metadata only to identify the promised scope; use repository bytes and command/API results as evidence.
>
> **What v0.1.9 must deliver (verify each, GO/NO-GO per item):**
>
> 0. **Candidate identity.** Confirm the working tree is at `<CANDIDATE_SHA>`, `main` contains that SHA, and the tracked tree is clean. The following untracked paths are operator scratch and MUST be ignored — their presence does NOT affect the verdict:
>    - `docs/announcement-feature-inventory.md` (operator notes)
>    - `docs/audits/` (audit outputs land here)
>    - `rule-packs/nerc-cip-ferc-ceii/` (in-progress pack, not part of v0.1.9 scope)
>
>    If the checked-out bytes do not match the declared candidate, NO-GO.
>
>    **Pre-tag UNKNOWNs that are NOT blockers.** Some checks below ask about post-tag artifacts (the `:0.1.9` image on GHCR, the v0.1.9 GitHub release asset URL). Before the tag is pushed, those artifacts do not exist yet — that is by design. Mark these UNKNOWN with the note "pre-tag artifact, will be produced by release workflow" and treat them as GO for verdict purposes. The release workflow itself is what produces them; if its source bytes are correct, the artifacts are too. Do NOT downgrade to NO-GO on these alone.
>
> 1. **PR #7 / sha7 from tag commit.** `.github/workflows/release.yml` `resolve-tag` must read `sha7` from `git rev-parse HEAD` after `actions/checkout` at the resolved tag, not from `${GITHUB_SHA::7}`. Walk both paths: tag-push of `v0.1.9` and `workflow_dispatch` from main with `ref=v0.1.9`. Confirm the manifest's `:sha-*` tag identifies the tag commit in both.
>
> 2. **PR #7 / concurrency block.** `concurrency:` group present at workflow level, scoped per-repo, `cancel-in-progress: false`. Two simultaneous releases must serialize, not race.
>
> 3. **PR #7 / verify-after-flip.** `sign-and-publicize` job must read package visibility back via the API after PATCH and **fail** the job if visibility ≠ "public". A silent flip failure can no longer ship a green release with private images.
>
> 4. **PR #7 / tag pattern tightened.** Workflow trigger uses `v[0-9]*.[0-9]*.[0-9]*`, not `v*`. A stray `vendored` tag cannot trigger a release.
>
> 5. **Issue #8 / IPv6 health checks.** `docker-compose.yml` health checks for `agentos-d` and `agentworks-n8n` must use `127.0.0.1`, not `localhost`. Verify by grep, not by trust.
>
> 6. **Issue #9 / `agentworks restart` recreate.** The CLI's `restart` command must call `docker compose up -d --force-recreate --remove-orphans` (with the existing env-var injection), not `docker compose restart`. Editing `docker-compose.yml` and running `agentworks restart` must visibly apply the change. Walk the code path from CLI entry to subprocess call.
>
> 7. **Issue #10 / rule pack hot reload.** `POST /api/policy/packs/reload` route must exist, must clear the module-level cache in `routes/mcp.ts`, and must rescan the rule-packs dir. `GET /api/policy/packs` must surface load errors in a `loadErrors[]` field; failed packs are no longer silently skipped.
>
> 8. **Issue #11 / configurable default pack.** `AGENTWORKS_DEFAULT_PACK_ID` env var must control the default-pack-on-tenant-creation, with empty string meaning "no auto-assignment". Verify the literal `"smb-starter"` is no longer hardcoded in `rule-pack-assignments.ts`.
>
> 9. **Issue #12 / admin UI opt-in.** Either an opt-in service in `docker-compose.yml` (commented out with a clear note) or a `docker-compose.admin.yml` overlay, plus README documentation. The default install footprint must NOT change. The dashboard must be discoverable from the README without grep.
>
> 10. **Issue #13 / Windows + WSL MCP wiring.** `agentworks mcp configure` must (a) detect WSL via `uname -r` containing `microsoft`, (b) accept `--target {claude-desktop,claude-code,both}`, (c) emit absolute WSL paths to Node binaries when the consumer is a Windows process. Test branches in code; do not assume a flag exists because a comment says so.
>
> **Hot zones — where prior releases broke. Re-walk these explicitly:**
>
> - **Tag casing.** `${{ github.repository_owner }}` is `SGridworks` (mixed case). Docker rejects uppercase repository paths. Confirm every Docker tag and GHCR API call goes through the lowercased prefix from `resolve-tag.outputs.image_prefix` or `owner_lc`. No raw `${{ github.repository_owner }}` interpolated into image paths.
>
> - **QEMU emulation.** No matrix shard or build step uses QEMU for arm64 emulation; arm64 must run on `ubuntu-24.04-arm`. If a future shard accidentally drops back to QEMU, builds will hang on `pnpm install` with SIGILL. Grep for any `setup-qemu-action` or `--platform linux/arm64` invocation on a non-arm runner.
>
> - **Cosign tag.** Cosign must sign `:<version>` (which exists), not `:v<version>` (which never exists because metadata-action strips the `v`). Re-confirm now that v0.1.9 will sign `:0.1.9`.
>
> - **GHCR public flip.** Both `/user/...` and `/orgs/<owner_lc>/...` paths attempted, with explicit visibility re-read after. Failure modes: token without `packages: write`, package doesn't exist on first release, propagation delay.
>
> - **Re-runnability on the same tag.** `softprops/action-gh-release@v2` against an existing release should overwrite `install.sh` cleanly. The release job must be safely re-dispatchable.
>
> **Fresh-install rehearsal — walk `apps/installer/src/install.sh` line-by-line under each persona:**
>
> For each persona below, walk the install script start-to-finish. Cite the line number where it would fail. If it does not fail, say "would complete and pass smoke test."
>
> 1. **Linux / amd64 / fresh Ubuntu 22.04 / Docker installed but never used / no AGENTWORKS_* env vars set.** The bare-minimum customer.
>
> 2. **macOS / Apple Silicon / Docker Desktop / shell is zsh / Homebrew Node 22 already on PATH.**
>
> 3. **macOS / Intel / Docker Desktop / Rosetta enabled / no Node on PATH.**
>
> 4. **Windows 11 / WSL2 Ubuntu / Docker Desktop with WSL integration / Node installed at `~/.local/bin/node` / Windows-side process needs to spawn `wsl -e node ...`.** Issue #13 territory — verify the install does not silently produce a broken MCP config.
>
> 5. **Re-install over a previous v0.1.8 install.** Existing `~/.agentworks/` contents, existing tenants, existing rule packs assigned, existing containers running. The script must be idempotent and must not nuke data. If it offers a "wipe and start over" path, that path must be opt-in.
>
> **Cross-reference checks (do these — these are where past customer bugs hid):**
>
> - Every env var in `.env` template → consumed by exactly one downstream service. Orphaned vars are bug bait.
> - Every service in `docker-compose.yml` → image actually exists on GHCR at `:0.1.9` (or built locally with a stable Dockerfile path).
> - Every rule pack ID referenced in code → matches a directory under `rule-packs/`.
> - Every health check endpoint → actually implemented in the corresponding service code.
> - Every smoke-test assertion → corresponds to a real API endpoint on a service that compose actually starts.
> - The exact `curl … | bash` command in README and on social → resolves to the same script that contains `INSTALLER_VERSION="0.1.9"`.
>
> **Output format — strict:**
>
> Section 1: **VERDICT.** One word. `GO` or `NO-GO`. No equivocation.
>
> Section 2: **Verification matrix.** Candidate identity, each numbered v0.1.9 commitment above (10 items), each Hot Zone (5 items), each Persona (5 personas), each Cross-reference check (6 items). Three columns: item, GO/NO-GO/UNKNOWN, one-line evidence with file:line.
>
> Section 3: **Blockers** (if any). For every NO-GO or UNKNOWN row above, provide:
>   - File and line
>   - Concrete failure mode (not "this might break" — what specifically breaks, for whom, in what step)
>   - Severity (BLOCKER / HIGH)
>
> Section 4: **Sleep cost.** What's the maintainer's expected pager probability in the week after the tag goes out, given what you found? One sentence.
>
> No fixes. No commentary on style. No "consider also". The output is a tag/no-tag decision plus the evidence behind it.

---

## After Codex returns

- **`GO` with no BLOCKER/HIGH** → tag v0.1.9, dispatch the workflow, monitor. Done.
- **Anything else** → fix the blockers, get a clean re-audit, then tag. The whole point is to never ship "well it might be fine."
- Save the audit output to `docs/audits/v0.1.9-go-nogo-<commit>.md` for the historical record.

## Why this is more aggressive than the prior pre-release prompt

The earlier `CODEX-PRE-RELEASE-AUDIT.md` is a 10-pass adversarial review that returns ranked findings. It catches issues but doesn't force a binary decision — the maintainer still has to weigh and judge.

This one is a **single decision question**: tag or don't tag. Every output column collapses to GO/NO-GO. Every "interesting finding" either justifies NO-GO or doesn't matter. The maintainer's required cognitive load drops to: "did Codex say GO? then I tag. did Codex say NO-GO? then I fix what Section 3 lists, no compromises."

If a finding does not move the GO/NO-GO bit, it does not appear. Codex polish, taste, and "while you're at it" suggestions belong in a different prompt.
