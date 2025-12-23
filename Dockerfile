# -------------------------
# deps: install workspace deps
# -------------------------
FROM node:20-bullseye-slim AS deps
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy root/workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy workspace package manifests (pnpm needs these for proper linking)
COPY apps/api/package.json ./apps/api/package.json
COPY packages/runner/package.json ./packages/runner/package.json
# If api depends on other workspace packages, add their package.json too:
# COPY packages/<name>/package.json ./packages/<name>/package.json

# Install with dev deps (needed for prisma + tsc during build)
ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false


# -------------------------
# builder: copy sources + build
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

# install production deps only
RUN pnpm install --frozen-lockfile --prod

# Bring installed deps forward
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/package.json ./package.json

# Copy actual sources
COPY apps/api ./apps/api
COPY packages/runner ./packages/runner

# IMPORTANT: re-run install to ensure workspace links exist with full source present
# (This is what prevents "Cannot find module fastify/zod" during tsc)
ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false

# Generate Prisma client + build API
RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build


# -------------------------
# runner: minimal prod image
# -------------------------
FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy only what runtime needs
COPY --from=builder /workspace/apps/api/dist ./apps/api/dist
COPY --from=builder /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=builder /workspace/apps/api/prisma ./apps/api/prisma

# Copy node_modules (keeps it simplest; later we can prune for smaller images)
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/package.json ./package.json
COPY --from=builder /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml

# If your api starts from apps/api/dist/index.js
CMD ["node", "apps/api/dist/index.js"]
