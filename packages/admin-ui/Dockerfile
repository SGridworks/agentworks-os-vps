# syntax=docker/dockerfile:1
#
# AgentWorks OS — admin-ui Dockerfile
# Multi-stage: pnpm install + Next.js build, then runtime serves the
# standalone output on PORT (default 3000).
#
FROM node:22-alpine AS builder

WORKDIR /app

# next.config.js rewrites are emitted during `next build`; inside Docker they
# must target the daemon's Docker-network hostname rather than 127.0.0.1.
ENV AGENTOS_API_URL=http://agentos-d:7710

RUN corepack enable && corepack prepare pnpm@9 --activate

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
COPY packages/admin-ui/.eslintrc.json ./packages/admin-ui/.eslintrc.json
COPY packages/admin-ui/next-env.d.ts ./packages/admin-ui/next-env.d.ts
COPY packages/admin-ui/next.config.js ./packages/admin-ui/next.config.js
COPY packages/admin-ui/postcss.config.js ./packages/admin-ui/postcss.config.js
COPY packages/admin-ui/tailwind.config.js ./packages/admin-ui/tailwind.config.js
COPY packages/admin-ui/tsconfig.json ./packages/admin-ui/tsconfig.json
COPY packages/admin-ui/lib ./packages/admin-ui/lib
COPY packages/admin-ui/pages ./packages/admin-ui/pages
COPY packages/admin-ui/src ./packages/admin-ui/src

RUN pnpm --filter @agentworks/shared build \
 && pnpm --filter admin-ui build

# next.js's COPY ./public step in the runtime stage requires the directory
# to exist, but admin-ui doesn't ship any static assets yet — ensure the
# directory exists so the multi-stage COPY does not fail on a fresh tree.
RUN mkdir -p /app/packages/admin-ui/public

# ------------------------------------------------------------------------------
# Runtime image
# ------------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Build-time rewrites in next.config.js must point at the daemon's Docker
# network hostname, not container-local 127.0.0.1.
ENV AGENTOS_API_URL=http://agentos-d:7710

COPY --from=builder /app/packages/admin-ui/.next ./.next
COPY --from=builder /app/packages/admin-ui/public ./public
COPY --from=builder /app/packages/admin-ui/package.json ./package.json
COPY --from=builder /app/packages/admin-ui/next.config.js ./next.config.js
COPY --from=builder /app/node_modules ./node_modules

# The monorepo install leaves some workspace dependency links only under
# pnpm's virtual-store root. Restore the package links the Next runtime expects.
RUN ln -sfn .pnpm/node_modules/next node_modules/next \
 && ln -sfn .pnpm/node_modules/react node_modules/react \
 && ln -sfn .pnpm/node_modules/react-dom node_modules/react-dom \
 && ln -sfn ../.pnpm/node_modules/next/dist/bin/next node_modules/.bin/next

EXPOSE 3000

CMD ["node_modules/.bin/next", "start", "-p", "3000"]
