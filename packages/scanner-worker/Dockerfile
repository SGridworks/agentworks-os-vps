# syntax=docker/dockerfile:1
#
# scanner-worker Dockerfile.
#
# Build context is this package directory (set in docker-compose.yml), not the
# repo root: the only build inputs are pyproject.toml, README.md, and src/.
#
FROM python:3.11-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# pyproject.toml + README must sit at /app; src/ must keep its subdir so
# hatchling can read src/scanner_worker/__version__.py for the dynamic version.
COPY pyproject.toml README.md /app/
COPY src/ /app/src/

# A non-editable install copies the package into ~/.local/lib/python3.11/...
# which we then ship to the runtime stage. `pip install -e .` would leave a
# .pth file pointing at /app/src — fine in the builder, broken at runtime.
RUN pip install --user --no-cache-dir .

FROM python:3.11-slim

WORKDIR /app

# Debian Trixie (slim base) renamed libffi7 -> libffi8.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libffi8 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH

EXPOSE 3101

# 3101 must match SCANNER_WORKER_PORT in docker-compose.yml; both default to
# 3101 if unset. Standalone `docker run scanner-worker` (no compose) lands on
# this default — keep them in sync if you change one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import httpx, os; httpx.get(f\"http://localhost:{os.environ.get('SCANNER_WORKER_PORT', '3101')}/health\").raise_for_status()"

ENTRYPOINT ["python", "-m", "scanner_worker.main"]
