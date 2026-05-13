# HTTP Contract: scanner-worker

**Version:** 0.1.0
**Base URL:** `http://127.0.0.1:3101` (sidecar internal only — not exposed publicly)
**Auth:** None (internal sidecar, called by agentos-d only)
**Content-Type:** `application/json` throughout

---

## Endpoints

### `GET /health`

Liveness/readiness probe. agentos-d polls this to confirm the sidecar is alive and definitions are loaded.

**Response `200`** — healthy

```json
{
  "status": "healthy",
  "scannerVersion": "0.1.0",
  "definitionsLoaded": true,
  "definitionsCount": 14
}
```

**Response `503`** — unhealthy (definitions failed to load)

```json
{
  "detail": {
    "status": "unhealthy",
    "scannerVersion": "0.1.0",
    "definitionsLoaded": false,
    "definitionsCount": 0
  }
}
```

| Field | Type | Description |
|---|---|---|
| `status` | string | `"healthy"` when scanner is operational |
| `scannerVersion` | string | scanner-worker semver |
| `definitionsLoaded` | bool | Whether security check definitions loaded successfully |
| `definitionsCount` | int | Number of loaded security check definitions |

---

### `POST /scan`

Submit a single agent config for scanning. Synchronous — scan completes within the request timeout and returns findings directly. For long-running scans, returns `202 Accepted` with a `scanId` to poll.

**Request body** — RFC 003 format

```json
{
  "tenantId": "tenant-abc",
  "scanId": "scan-d4e5f6",
  "target": {
    "type": "claude_md",
    "path": "/home/user/.claude/CLAUDE.md",
    "content": "# Claude\nYou are a helpful AI..."
  },
  "policyMode": "shadow",
  "priority": "standard"
}
```

| Field | Required | Description |
|---|---|---|
| `tenantId` | Yes | Tenant/organization scope |
| `scanId` | Yes | Caller-supplied unique scan ID |
| `target.type` | Yes | `claude_md`, `cursorrules`, `mcp_config`, `n8n_workflow` |
| `target.path` | Yes | Absolute path to the target file |
| `target.content` | Yes | Raw file content |
| `policyMode` | No | `shadow` (default) or `enforce` |
| `priority` | No | `standard` (default) or `high` |

**Response `200`** — synchronous complete

```json
{
  "scanId": "scan-d4e5f6",
  "status": "complete",
  "findings": [
    {
      "id": "CONFIG-001",
      "severity": "high",
      "ruleId": "excessive-agency",
      "title": "Missing safety boundary instructions",
      "description": "The agent config lacks a refuse/resist instruction block.",
      "location": {
        "file": "/home/user/.claude/CLAUDE.md",
        "line": 3,
        "column": 0
      },
      "remediation": "Add explicit refusal guidelines such as: 'If asked to do something harmful, illegal, or outside your approved scope, refuse and explain why.'"
    }
  ],
  "scannedAt": "2026-04-30T17:00:00Z"
}
```

**Response `202`** — async queued (estimatedSeconds to poll)

```json
{
  "scanId": "scan-d4e5f6",
  "status": "queued",
  "estimatedSeconds": 30
}
```

**Response `400`** — invalid target type

```json
{
  "detail": {
    "error": "invalid_target_type",
    "message": "Unknown target type 'unknown_type'",
    "details": {}
  }
}
```

**Response `503`** — scanner unavailable

```json
{
  "detail": {
    "error": "scanner_unavailable",
    "message": "Scanner worker is not responding. Scan paused."
  }
}
```

---

### `GET /scan/{scanId}`

Poll for the result of a previously submitted async scan.

**Response `200`** — found

```json
{
  "scanId": "scan-d4e5f6",
  "status": "complete",
  "findings": [...],
  "scannedAt": "2026-04-30T17:00:00Z"
}
```

**Response `404`** — unknown scanId

```json
{
  "detail": {
    "error": "scan_not_found",
    "message": "Scan scan-d4e5f6 not found."
  }
}
```

---

### `POST /scan/batch`

Submit multiple targets in one request for nightly full-scan.

**Request body**

```json
{
  "tenantId": "tenant-abc",
  "batchId": "batch-001",
  "targets": [
    {
      "type": "claude_md",
      "path": "/home/user/.claude/CLAUDE.md",
      "content": "..."
    },
    {
      "type": "cursorrules",
      "path": "/home/user/.cursor/rules.md",
      "content": "..."
    }
  ],
  "policyMode": "shadow",
  "priority": "standard"
}
```

**Response `200`** — all complete synchronously

```json
{
  "batchId": "batch-001",
  "status": "complete",
  "results": [
    {
      "scanId": "scan-001",
      "status": "complete",
      "findings": [],
      "scannedAt": "2026-04-30T17:00:00Z"
    }
  ]
}
```

**Response `202`** — partially or fully async

```json
{
  "batchId": "batch-001",
  "status": "queued",
  "targetCount": 5,
  "estimatedSeconds": 300
}
```

---

### `GET /scan/{scanId}/sarif`

Export completed scan results in SARIF 2.1.0 format.

**Response `200`** — SARIF JSON

```json
{
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [...]
}
```

**Response `404`** — scan not found
**Response `503`** — scanner unavailable

---

## Finding Object

```json
{
  "id": "CONFIG-001",
  "severity": "high",
  "ruleId": "excessive-agency",
  "title": "Missing safety boundary instructions",
  "description": "The agent config lacks a refuse/resist instruction block.",
  "location": {
    "file": "/home/user/.claude/CLAUDE.md",
    "line": 3,
    "column": 0
  },
  "remediation": "Add explicit refusal guidelines..."
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Finding identifier (e.g. CONFIG-001) |
| `severity` | string | `critical`, `high`, `medium`, `low`, `info` |
| `ruleId` | string\|null | Rule that triggered this finding |
| `title` | string | Human-readable finding title |
| `description` | string | Detailed explanation |
| `location` | object\|null | `{file, line, column}` of the finding |
| `remediation` | string\|null | Recommended fix |
| `affected_endpoint` | string\|null | Internal compat — file URL |
| `evidence` | string\|null | Raw evidence from scanner |
| `cwe_id` | string\|null | CWE weakness identifier |
| `cvss_score` | number\|null | CVSS base score (0-10) |
| `references` | string[] | Reference URLs |

---

## Severity Levels

`critical` > `high` > `medium` > `low` > `info`

Risk score formula (capped at 10.0):
```
score = max(severity_scores, cvss_score if present)
CRITICAL=10, HIGH=5, MEDIUM=2, LOW=0.5, INFO=0
```

---

## Watch Directory Poller

When `WATCH_DIRS` env var is set, the poller watches those paths and auto-triggers scans on changes.

```
WATCH_DIRS=/home/user/agents:/home/user/.claude:60
```

Format: colon-separated paths, optional `:interval` suffix per path.

Files monitored: `CLAUDE.md`, `.cursorrules`, `mcp.json`, `*.json` (configurable).

Scan results from the poller are **not** stored by the sidecar — the caller (agentos-d) is responsible for persistence and surfacing findings.

---

## Scan Status Lifecycle

```
accepted → running → completed
                    ↘ failed
                    ↘ crashed (mid-scan kill, timeout, worker shutdown)
```

- `accepted`: request queued, scan task running
- `running`: scan in progress, poll again
- `completed`: scan finished, findings available
- `failed`: scan failed with an error
- `crashed`: scan cancelled, killed mid-run, or worker shutting down
