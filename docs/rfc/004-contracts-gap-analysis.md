# RFC 004 — Contracts Gap Analysis v0.1

**Status**: Decision Locked — RFC 003 wins (2026-04-28 by TechLead)
**Author**: TechLead
**Created**: 2026-04-27
**Blocks**: AWO-26 (DB migration), scanner-worker implementation
**Review**: PythonEngineer confirmed; CEO notified

---

## Problem

Two contracts exist for the scanner-worker HTTP interface. They are incompatible. RFC 003 was written after the initial scaffold was created, but the scaffold was not updated. Implementation cannot proceed until the contract is resolved.

This RFC documents the gap and commits to RFC 003 as the source of truth.

---

## Gap Detail

### scanner-worker `models.py` (existing scaffold)

```
POST /scan body:  ScanRequestInput
  - scan_path?: string
  - scan_url?: string
  - paste_content?: string
  - scan_type: "full" | "quick" | "custom"
  - checks?: string[]
  - agent_name?: string

Response: ScanResponse
  - scan_id: string
  - status: "completed" | "error" | "cancelled"
  - findings: Finding[]
  - findings_count: number
  - risk_score: number
  - scanned_path: string | null
  - scanned_url: string | null
  - framework: string | null
  - duration_seconds: number
  - completed_at: datetime
  - error_message: string | null

Finding shape:
  - id, severity, title, description
  - affected_endpoint (string)     ← RFC uses location.file + line + column
  - evidence: string | null
  - remediation: string
  - cwe_id: string | null
  - cvss_score: number | null
  - references: string[]
```

### RFC 003 `POST /scan` (intended design)

```
POST /scan body:
  - tenantId: uuid               ← missing from scaffold
  - scanId: uuid                ← missing from scaffold (client generates)
  - target: { type, path, content }
  - policyMode: "shadow" | "enforce"
  - priority: "standard" | "high"

Response 200: ScanResult
  - scanId: uuid
  - status: "complete" | "error"
  - findings: Finding[]
  - scannedAt: ISO8601

Response 202: QueuedResult
  - scanId: uuid
  - status: "queued"
  - estimatedSeconds: number

Finding shape:
  - id, severity, ruleId, title, description
  - location: { file, line, column }   ← scaffold uses affected_endpoint
  - remediation: string
```

### Key differences

| Field | Scaffold | RFC 003 |
|---|---|---|
| tenantId | absent | required |
| scanId | scanner-generated | client-generated |
| input mode | three mutually exclusive flat fields | discriminated `target` object |
| policyMode | absent | present |
| priority | absent | present |
| Finding.location | absent (uses affected_endpoint) | { file, line, column } |
| Finding.ruleId | absent | present |
| batch endpoint | absent | POST /scan/batch |
| async polling | not designed | GET /scan/{scanId} |
| health shape | scanner_ready, watch_dir | scannerVersion, definitionsLoaded |

---

## Decision

**RFC 003 is the source of truth.** The scaffold was an early draft that predated the API design review. PythonEngineer implements RFC 003 directly.

Consequences:
- `models.py` must be rewritten against RFC 003 types
- `ScanRequestInput`, `ScanResponse`, and `Finding` shapes are replaced
- New types needed: `ScanTarget`, `ScanResult`, `QueuedResult`, `BatchScanRequest`, `BatchScanResult`, `HealthResponse` (RFC-aligned)
- `GET /scan/{scanId}` polling endpoint must be implemented
- `POST /scan/batch` endpoint must be implemented
- `tenantId` must be accepted and returned in findings (for Issue creation in paperclip)

---

## Action

1. PythonEngineer: delete the scaffolded `models.py` Finding/ScanRequestInput shapes; implement RFC 003 types from scratch
2. The `agentguard-scanner` library (from agentguard main) has its own internal models — the scanner-worker HTTP contract types are **separate** from agentguard internal models. Do not conflate them.
3. scanner-worker HTTP contract is versioned at `/api/v1`. Any breaking change increments the version.

---

## Notes for PythonEngineer

The existing `models.py` has one useful thing: the `validate_exactly_one_input()` pattern for mutually exclusive fields. Carry that pattern forward into the RFC 003 `target` discriminated union.

```python
# Recommended: Pydantic v2 discriminated unions for target
class ScanTarget(BaseModel):
    type: Literal["claude_md", "cursorrules", "mcp_config", "n8n_workflow"]
    path: str | None = None
    content: str | None = None

    # validation in model_validator
```

---

## Open Questions

None — RFC 003 is the source of truth, this RFC closes the gap.
