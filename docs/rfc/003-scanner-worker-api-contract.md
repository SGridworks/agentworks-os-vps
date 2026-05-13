# RFC 003 — Scanner-Worker HTTP API Contract v0.1

**Status**: Ready for Review — pending CEO + PythonEngineer sign-off
**Author**: TechLead
**Created**: 2026-04-27
**Blocks**: AWO-26 (DB migration), scanner-worker implementation
**Review**: CEO + PythonEngineer must sign off before implementation

---

## Problem

`agentos-d` (TypeScript daemon) must communicate with `scanner-worker` (Python/FastAPI sidecar) for continuous security scanning of agent configurations. The protocol must be reliable, async-friendly, and have clear error semantics. Both sides need a stable wire format before implementation starts.

---

## Architecture

```
agentos-d (TS)  ←→  HTTP/JSON  ←→  scanner-worker (Python/FastAPI)
                          ↓
                    localhost:8001
                    (internal only,
                     not exposed)
```

Scanner-worker runs zero-network (Apache-2.0 AgentGuard constraint). All communication is local HTTP between the two containers on the same Docker network.

---

## Base URL

```
http://scanner-worker:8001/api/v1
```

`agentos-d` reaches the sidecar via Docker Compose service name, not localhost. Both containers on the same `agentworks` network.

---

## Endpoints

### `POST /scan`

Submit an agent configuration for scanning.

**Request**

```json
{
  "tenantId": "uuid",
  "scanId": "uuid",
  "target": {
    "type": "claude_md" | "cursorrules" | "mcp_config" | "n8n_workflow",
    "path": "/path/to/config",
    "content": "... raw file content ..."
  },
  "policyMode": "shadow" | "enforce",
  "priority": "standard" | "high"
}
```

**Response** `200 OK`

```json
{
  "scanId": "uuid",
  "status": "complete" | "error",
  "findings": [
    {
      "id": "string",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "ruleId": "string",
      "title": "string",
      "description": "string",
      "location": {
        "file": "string",
        "line": 42,
        "column": 5
      },
      "remediation": "string"
    }
  ],
  "scannedAt": "ISO8601"
}
```

**Response** `202 Accepted` (async — for large scans)

```json
{
  "scanId": "uuid",
  "status": "queued",
  "estimatedSeconds": 30
}
```

**Error** `400 Bad Request`

```json
{
  "error": "invalid_target_type",
  "message": "...",
  "details": {}
}
```

**Error** `503 Service Unavailable`

```json
{
  "error": "scanner_unavailable",
  "message": "Scanner worker is not responding. Scan paused."
}
```

---

### `GET /scan/{scanId}`

Poll for async scan result.

**Response** `200 OK` — same body as `POST /scan` 200.

**Response** `404 Not Found`

---

### `POST /scan/batch`

Submit multiple targets in one request (for nightly full-scan).

**Request**

```json
{
  "tenantId": "uuid",
  "batchId": "uuid",
  "targets": [ /* array of target objects same as POST /scan */ ],
  "policyMode": "shadow",
  "priority": "standard"
}
```

**Response** `202 Accepted`

```json
{
  "batchId": "uuid",
  "status": "queued",
  "targetCount": 12,
  "estimatedSeconds": 300
}
```

**Response** `200 OK` (if all sync-complete)

```json
{
  "batchId": "uuid",
  "status": "complete",
  "results": [ /* array of scan results */ ]
}
```

---

### `GET /health`

Liveness/readiness probe from `agentos-d`.

**Response** `200 OK`

```json
{
  "status": "healthy",
  "scannerVersion": "0.1.0",
  "definitionsLoaded": true,
  "definitionsCount": 47
}
```

**Response** `503 Service Unavailable`

```json
{
  "status": "unhealthy",
  "reason": "definitions_failed_to_load"
}
```

---

## Error Handling

1. Scanner-worker is unavailable → `agentos-d` pauses scan submissions, logs `scanner_unavailable`, surfaces in admin UI as "Scanner paused".
2. Scan times out (>60s per target) → returns partial results with `status: error` and `error: timeout`.
3. Invalid target type → `400 Bad Request` with `invalid_target_type`.
4. `agentos-d` retries with exponential backoff on 503, max 3 attempts.

---

## Auth

Internal only (Docker network). No auth required for v0.1. Both containers on the same `agentworks` Docker network. External exposure is blocked at the Docker Compose level (no port 8001 published to host).

---

## Mapping to Paperclip Issues

Scanner findings surface as **Issues** in paperclip:

```
POST /scan result.findings[]
  → paperclip issues (via agentos-d)
  → issue.originKind = "scanner_finding"
  → issue.originId = finding.id
  → issue.title = finding.title
  → issue.description = finding.description + remediation
```

This is the only cross-service write from scanner-worker. All other data flows through `agentos-d` as the write path.

---

## Open Questions

1. Streaming scan progress (SSE)? Defer to v1.1. v0.1 uses poll-based async.
2. Scanner-worker initiating connection (webhook from scanner to agentos-d)? Not for v0.1. agentos-d polls.
3. Batch scan deduplication — if same content scanned twice in 24h, skip? v0.1: no deduplication. Scanner-worker is idempotent.
