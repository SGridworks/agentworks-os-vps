     1|# Brand Naming Convention — AgentWorks to AgentWorks OS
     2|
     3|This document maps every product name, package name, path, and string that changes when rebranding from AgentWorks to AgentWorks OS. It is the authoritative reference for the v1 rebrand.
     4|
     5|**Status:** draft
     6|**Owner:** TechnicalWriter
     7|**Escalation:** CEO for product naming decisions, technical lead for technical path/package renames
     8|
     9|---
    10|
    11|## Product Names
    12|
    13|| Old name | New name | Notes |
    14||---|---|---|
    15|| Paperclip | AgentWorks OS | The local-first AI compliance substrate. "AgentWorks OS" is the full product name; "AgentWorks" alone refers to the company or platform. |
    16|| Paperclip OS | AgentWorks OS | Same product. The "OS" suffix is retained. |
    17|| AgentWorks server | agentos-d | The daemon process. Lowercase, hyphenated. |
    18|| Paperclip, Inc. | SGridworks | The company. Used in legal contexts, rule pack credentials, attorney bylines. |
    19|| Paperclip adapter | agent adapter | Generic. Specific adapters: `claude-local`, `opencode`, `cursor`, `codex`, `gemini`, `pi`, `OpenClaw-gateway`, `Hermes`. |
    20|| Paperclip API | AgentWorks API | The REST + MCP surface. Version: `v1`. Base URL: `http://agentworks.local:7710`. |
    21|| Compliance Certificate | Compliance Evidence Report | Per Codex critique: "certificate" invites liability the product reduces. The report summarizes policy decisions, approval queue activity, and scanner findings. Monthly, signed, hash-chained. |
    22|| AgentWorks CLI | agentworks CLI | The command-line tool. Commands: `agentworks install`, `agentworks update`, `agentworks backup`, `agentworks restore`, `agentworks pack validate`. |
    23|
    24|---
    25|
    26|## Code and Package Names
    27|
    28|| Old name | New name | Notes |
    29||---|---|---|
    30|| `AgentWorks/server` | `agentos-d` | The daemon package/directory. |
    31|| `AgentWorks/packages/adapters` | `packages/agent-adapters` | The adapter SDK. |
    32|| `AgentWorks/packages/db` | `packages/db` | Unchanged — DB schema package. |
    33|| `@AgentWorks/...` | `@agentworks/...` | npm scope. |
    34|| `AgentWorks-ui` | `admin-ui` | The Next.js admin interface. |
    35|| `AgentWorks.docker` image | `agentos-d` image | GHCR: `ghcr.io/sgridworks/agentos-d`. |
    36|| `AgentWorks/scanner` | `scanner-worker` | The AgentGuard sidecar service. |
    37|| `~/AgentWorks` | `~/agentworks` | Local install root on the customer's machine. |
    38|
    39|---
    40|
    41|## URL and Hostname Names
    42|
    43|| Old name | New name | Notes |
    44||---|---|---|
    45|| `AgentWorks.local` | `agentworks.local` | Local hostname for the daemon. |
    46|| `AgentWorks:3100` | `agentworks.local:7710` | MCP server and REST API. |
    47|| `get.AgentWorks.io` | `get.agentworks.os` | Installer download URL. |
    48|| `api.AgentWorks.ing` | not used in v1 | v1 is local-only. No SaaS API hostname. |
    49|
    50|---
    51|
    52|## Repo and Path Names
    53|
    54|| Old name | New name | Notes |
    55||---|---|---|
    56|| `github.com/AgentWorks-ui/AgentWorks` | `github.com/SGridworks/agentworks-os` | Main repo. |
    57|| `AgentWorks/server/src/` | `agentos-d/src/` | Daemon source. |
    58|| `AgentWorks/packages/` | `packages/` | Monorepo packages under `agentworks-os/`. |
    59|| `AgentWorks/.claude/skills/` | `.claude/skills/` | Claude skills. No brand in path. |
    60|
    61|---
    62|
    63|## Paperclip Internal Concepts — Renamed
    64|
    65|| Old name | New name | Notes |
    66||---|---|---|
    67|| Paperclip company | AgentWorks tenant | A "company" in AgentWorks is a customer tenant in AgentWorks OS. The DB schema uses `tenant_id` everywhere in v1 refactors. |
    68|| Paperclip agent | AgentWorks agent | An AI agent connected to the substrate. |
    69|| AgentWorks issue | Issue | Unchanged. Issues are the work-tracking unit. Prefix: `AWO-`. |
    70|| AgentWorks project | Project | Unchanged. |
    71|| AgentWorks goal | Goal | Unchanged. |
    72|| AgentWorks work product | Work product | Unchanged. |
    73|
    74|---
    75|
    76|## Rule Pack Names
    77|
    78|| Old name | New name | Notes |
    79||---|---|---|
    80|| SMB Starter | SMB Compliance Starter | The free tier pack. |
    81|| TCPA Real Estate | TCPA Real Estate | Unchanged — already named for the regulation. |
    82|| Fair Housing Real Estate | Fair Housing Real Estate | Unchanged. |
    83|| HIPAA Healthcare | HIPAA Healthcare | Unchanged. |
    84|
    85|---
    86|
    87|## Environment Variable Names
    88|
    89|| Old name | New name | Notes |
    90||---|---|---|
    91|| `PAPERCLIP_PORT` | `AGENTWORKS_PORT` | Daemon listen port. |
    92|| `PAPERCLIP_DB_URL` | `AGENTWORKS_DB_URL` | Database connection string. |
    93|| `PAPERCLIP_TENANT_ID` | `AGENTWORKS_TENANT_ID` | Current tenant. |
    94|| `PAPERCLIP_MCP_URL` | `AGENTWORKS_MCP_URL` | MCP server URL for agent config. |
    95|
    96|---
    97|
    98|## String Replacements in Code
    99|
   100|When refactoring AgentWorks → agentos-d, replace these exact strings:
   101|
   102|```
   103|Paperclip → AgentWorks OS  (product name, UI strings)
   104|AgentWorks → agentos-d       (daemon name, process name, hostnames)
   105|AgentWorks.local → agentworks.local
   106|Paperclip, Inc. → SGridworks
   107|PAPERCLIP_ → AGENTWORKS_  (env vars)
   108|AgentWorks-ui → admin-ui    (directory name)
   109|ghcr.io/AgentWorks → ghcr.io/sgridworks/agentos-d
   110|```
   111|
   112|---
   113|
   114|## What NOT to Rename
   115|
   116|| Name | Reason |
   117||---|---|
   118|| Vault | The memory substrate. Vault is a product-agnostic concept (Hermes vault skills, Obsidian vault). Retained as-is. |
   119|| MCP | Model Context Protocol — Anthropic's standard. Not renamed. |
   120|| AWCP | AgentWorks Compliance Protocol — the spec namespace. Not renamed. |
   121|| TCPA / Fair Housing / HIPAA | Legal regulation names. Not renamed. |
   122|| `agentworks` CLI | The CLI tool name. Matches product name. |
   123|| `agentos-d` daemon | The "d" stands for daemon. Not "agentos-daemon." |
   124|
   125|---
   126|
   127|## Installer String Map
   128|
   129|The installer (`curl -fsSL https://get.agentworks.os/install.sh | bash`) prints these strings:
   130|
   131|| Old (AgentWorks) | New (AgentWorks OS) |
   132||---|---|
   133|| "Paperclip is installing..." | "AgentWorks OS is installing..." |
   134|| "Paperclip has been installed." | "AgentWorks OS has been installed." |
   135|| "Visit http://AgentWorks.local:3000 to complete setup." | "Visit https://agentworks.local:3000 to complete setup." |
   136|| Default username: `AgentWorks` | Default username: `admin` |
   137|| Config path: `~/.AgentWorks/` | Config path: `~/.agentworks/` |
   138|
   139|---
   140|
   141|## Admin UI Strings
   142|
   143|| Old | New |
   144||---|---|
   145|| "Paperclip" (top-left logo text) | "AgentWorks OS" |
   146|| "Paperclip Admin" (page title) | "AgentWorks OS — Admin" |
   147|| "Paperclip Issues" | "Issues" |
   148|| "Paperclip Projects" | "Projects" |
   149|| "Compliance Certificate" | "Compliance Evidence Report" |
   150|
   151|---
   152|
   153|## Error Messages
   154|
   155|| Old | New |
   156||---|---|
   157|| "Paperclip is not running." | "AgentWorks OS is not running." |
   158|| "Paperclip daemon not found." | "agentos-d not found." |
   159|| "Failed to connect to Paperclip." | "Failed to connect to AgentWorks OS." |
   160|
   161|---
   162|
   163|## Deferred Naming Questions
   164|
   165|These product names are not locked for v1. Decide before v1.1:
   166|
   167|1. **"AgentWorks OS" vs "AgentWorks" vs "AgentOS"** — run past 2-3 prospects before locking
   168|2. **"agentos-d" vs "agentos-daemon" vs "agentwd"** — "d" suffix is Unix-conventional but may confuse non-technical operators
   169|3. **Subfolder name inside `~/Library/Application Support/`** — `AgentWorks` vs `agentworks-os` vs `sgridworks-agentworks` (macOS convention uses title case)
   170|