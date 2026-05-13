# syntax=docker/dockerfile:1
#
# AgentWorks OS — n8n image with bundled custom nodes
#
# Multi-stage:
#   1. builder — installs pnpm, restores the workspace, builds n8n-nodes
#      from source. Produces dist/ inside the build container.
#   2. runtime — n8n image with the freshly-built dist/ + package.json
#      copied into n8n's discoverable node_modules path.
#
# Built from the repo root (compose `context: .`); on a fresh clone the
# workspace's dist/ is gitignored, so we MUST build inside the image.
# Doing it via a host pre-step would force every installer to install
# pnpm and Node, defeating the "two scripts, exit 0" install contract.
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

# Same pattern as packages/agentos-d/Dockerfile: copy every workspace
# package.json so pnpm can resolve workspace:* protocols cleanly.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/policy-engine/package.json ./packages/policy-engine/package.json
COPY packages/memory/package.json ./packages/memory/package.json
COPY packages/pdf/package.json ./packages/pdf/package.json
COPY packages/agentos-d/package.json ./packages/agentos-d/package.json
COPY packages/n8n-nodes/package.json ./packages/n8n-nodes/package.json
COPY packages/admin-ui/package.json ./packages/admin-ui/package.json
COPY packages/awcp/package.json ./packages/awcp/package.json
COPY packages/agent-adapters/package.json ./packages/agent-adapters/package.json
COPY apps/installer/package.json ./apps/installer/package.json

RUN pnpm install --frozen-lockfile --prod=false

COPY packages/n8n-nodes/src ./packages/n8n-nodes/src
COPY packages/n8n-nodes/tsconfig.json ./packages/n8n-nodes/tsconfig.json

RUN pnpm --filter @agentworks/n8n-nodes build

# ------------------------------------------------------------------------------
# Runtime image
# ------------------------------------------------------------------------------
FROM n8nio/n8n:1.68.0

USER root

WORKDIR /home/node/.n8n

COPY --from=builder --chown=node:node /app/packages/n8n-nodes/dist /tmp/agentworks-nodes/dist
COPY --from=builder --chown=node:node /app/packages/n8n-nodes/package.json /tmp/agentworks-nodes/agentworks-nodes-package.json

# n8n auto-discovers nodes by scanning for packages with an "n8n" field in their
# package.json (same mechanism community-installed packages use).
RUN mkdir -p node_modules/@agentworks/n8n-nodes && \
    cp /tmp/agentworks-nodes/agentworks-nodes-package.json node_modules/@agentworks/n8n-nodes/package.json && \
    cp -r /tmp/agentworks-nodes/dist/* node_modules/@agentworks/n8n-nodes/ && \
    chown -R node:node node_modules/@agentworks/

# Smoke-test: package.json is loadable and lists the expected nodes.
RUN node --input-type=module <<'EOF'
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const p = require('/home/node/.n8n/node_modules/@agentworks/n8n-nodes/package.json');
console.log('Package name:', p.name);
console.log('n8n nodes:', p.n8n?.nodes?.length, 'nodes configured');
EOF

USER node
