FROM node:20-alpine AS deps
WORKDIR /workspace
# Use Corepack to install a matching pnpm version without touching Node.js directly.
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ✅ add workspace package manifests (important for pnpm workspaces)
COPY apps/api/package.json ./apps/api/package.json
COPY packages/runner/package.json ./packages/runner/package.json
# add more packages/*/package.json if api depends on them

RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/package.json ./package.json
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile


# ✅ generate Prisma client before TS build
RUN pnpm --filter api exec prisma generate

# ✅ install Playwright browsers so runners have the headless shells
RUN pnpm --filter api exec playwright install --with-deps

RUN pnpm --filter api build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Prisma on alpine often needs openssl + libc compatibility
RUN apk add --no-cache openssl libc6-compat

COPY --from=builder /workspace/apps/api/dist ./dist
COPY --from=builder /workspace/apps/api/package.json ./package.json
COPY --from=builder /workspace/apps/api/prisma ./prisma
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /ms-playwright /ms-playwright

EXPOSE 8787

# Run server directly (migrations handled in CI)
CMD ["node", "dist/index.js"]
