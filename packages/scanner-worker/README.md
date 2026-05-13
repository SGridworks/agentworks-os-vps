# scanner-worker

> **Third-Party Software Notice**
>
> This package incorporates `agentguard-scanner` (v0.1.0) by SGridworks,
> originally distributed at https://github.com/SGridworks/agentguard.
> License: Apache-2.0. Vendored source lives under `src/scanner_worker/security/`.

AgentGuard scanner sidecar for AgentWorks OS.
Wraps the Apache-2.0 licensed `agentguard-scanner` package as a FastAPI HTTP service.

## Quick Start

```bash
# Install
pip install -e packages/scanner-worker

# Run
scanner-worker
# or
python -m scanner_worker.main

# With watch directories
WATCH_DIRS=$HOME/agents python -m scanner_worker.main
```

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | /health | Liveness probe |
| POST | /scan | Submit a scan, get job_id |
| GET | /scan/{job_id} | Poll for results |
| POST | /scan/{job_id}/cancel | Cancel a scan |

See [docs/http-contract.md](docs/http-contract.md) for full API reference.

## Development

```bash
cd packages/scanner-worker
pip install -e ".[dev]"
pytest tests/ -q
mypy src/
ruff check src/
```

## Architecture

- `scanner_worker/models.py` — Pydantic request/response models
- `scanner_worker/service.py` — ScannerWorker: job tracking, resilience, graceful shutdown
- `scanner_worker/watcher.py` — WatchDirectoryPoller: file-system change detection
- `scanner_worker/app.py` — FastAPI application and HTTP routes
- `scanner_worker/main.py` — uvicorn entry point

## Resilience

- Scans run as asyncio tasks; mid-scan kills set status=crashed
- `/health` returns active_scans count and running flag
- Shutdown cancels in-flight scans gracefully (10s timeout)
- No scan results written to disk — caller persists
