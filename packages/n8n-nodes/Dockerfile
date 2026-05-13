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

# AgentWorks nodes live OUTSIDE /home/node/.n8n so that compose can bind-mount
# the user's .n8n data dir over /home/node/.n8n without shadowing them.
# n8n discovers them via N8N_CUSTOM_EXTENSIONS (set in docker-compose.yml).
WORKDIR /opt/agentworks-extensions

COPY --from=builder --chown=node:node /app/packages/n8n-nodes/dist /tmp/agentworks-nodes/dist
COPY --from=builder --chown=node:node /app/packages/n8n-nodes/package.json /tmp/agentworks-nodes/agentworks-nodes-package.json

# Install the package layout n8n's custom-extensions loader expects:
#   $N8N_CUSTOM_EXTENSIONS/node_modules/@agentworks/n8n-nodes/
#     ├ package.json          (n8n.nodes paths reference dist/.../*.node.js)
#     └ dist/
#         ├ policy-check/PolicyCheck.node.js
#         ├ memory/{MemoryRead,MemoryWrite}.node.js
#         ├ dispatch/Dispatch.node.js
#         └ automation/AutomationAction.node.js
#
# DO NOT flatten dist/* into the package root. package.json's n8n.nodes
# array uses "dist/.../*.node.js" paths; flattening breaks node discovery.
RUN mkdir -p /opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist && \
    cp /tmp/agentworks-nodes/agentworks-nodes-package.json \
       /opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/package.json && \
    cp -r /tmp/agentworks-nodes/dist/. \
          /opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist/ && \
    rm -rf /tmp/agentworks-nodes && \
    chown -R node:node /opt/agentworks-extensions

# Smoke-test: package.json is loadable and lists the expected nodes.
RUN node --input-type=module <<'EOF'
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const p = require('/opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/package.json');
console.log('Package name:', p.name);
console.log('n8n nodes:', p.n8n?.nodes?.length, 'nodes configured');
EOF

USER node
WORKDIR /home/node
