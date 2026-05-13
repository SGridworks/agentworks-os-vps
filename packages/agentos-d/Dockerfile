# syntax=docker/dockerfile:1
#
# agentos-d Dockerfile.
# Multi-stage: build TypeScript, bundle a self-contained deployment with
# `pnpm deploy`, then ship a lightweight Node runtime image.
#
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

# Workspace root + every workspace package.json. pnpm needs to see the full
# workspace to resolve `workspace:*` protocols, including ones declared in
# devDependencies of the root package.json (e.g. @agentworks/n8n-nodes).
# Copying every package.json keeps the install contract independent of which
# package we are deploying, at a cost of ~10 KB.
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

COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/policy-engine/src ./packages/policy-engine/src
COPY packages/policy-engine/tsconfig.json ./packages/policy-engine/tsconfig.json
COPY packages/memory/src ./packages/memory/src
COPY packages/memory/tsconfig.json ./packages/memory/tsconfig.json
COPY packages/pdf/src ./packages/pdf/src
COPY packages/pdf/tsconfig.json ./packages/pdf/tsconfig.json
COPY packages/agentos-d/src ./packages/agentos-d/src
COPY packages/agentos-d/tsconfig.json ./packages/agentos-d/tsconfig.json

RUN pnpm --filter @agentworks/shared build \
 && pnpm --filter @agentworks/policy-engine build \
 && pnpm --filter @agentworks/memory build \
 && pnpm --filter @agentworks/pdf build \
 && pnpm --filter @agentworks/agentos-d build

# `pnpm deploy` materializes a flat, self-contained node_modules tree at
# /deploy. This avoids the trap of copying packages/agentos-d/node_modules
# directly: pnpm uses relative symlinks into the virtual store at
# .pnpm/<pkg>@<ver>, and those break the moment the directory is moved.
RUN pnpm deploy --filter @agentworks/agentos-d --prod /deploy

# ------------------------------------------------------------------------------
# Runtime image
# ------------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache curl && rm -rf /var/cache/apk/*

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/dist ./dist
COPY --from=builder /deploy/package.json ./package.json

# Bundle rule packs into the image so policy.check works out of the box.
# Customers can override with RULE_PACKS_DIR pointing at a host volume.
COPY rule-packs /opt/agentworks/rule-packs

ENV NODE_ENV=production \
    AGENTOS_HOST=0.0.0.0 \
    AGENTOS_PORT=7710 \
    RULE_PACKS_DIR=/opt/agentworks/rule-packs \
    VAULT_ROOT=/data/vault

EXPOSE 7710

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${AGENTOS_PORT}/api/health || exit 1

ENTRYPOINT ["node", "dist/cli.js"]
