# -------------------------
# deps: install workspace deps (dev deps included for build)
# -------------------------
FROM node:20-bullseye-slim AS deps
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/runner/package.json ./packages/runner/package.json

ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false


# -------------------------
# builder: copy sources + build
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/package.json ./package.json

ARG CACHEBUST=1
RUN echo "cachebust=$CACHEBUST"

COPY apps/api ./apps/api
COPY packages/runner ./packages/runner

ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false

RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build


# -------------------------
# runner: prod install (real deps) + prisma generate + playwright browsers
# -------------------------
FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy manifests (include web manifest so pnpm workspace doesn't lstat fail)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/runner/package.json ./packages/runner/package.json

# Install prod deps in the runner (no pnpm symlink breakage)
RUN pnpm install --frozen-lockfile --prod

# Prisma generate needs schema present
COPY apps/api/prisma ./apps/api/prisma
WORKDIR /app/apps/api
RUN pnpm exec prisma generate
WORKDIR /app

# Install Playwright Chromium + OS deps into the final image
RUN pnpm --filter api exec playwright install --with-deps chromium

ARG CACHEBUST=1
RUN echo "runner-cachebust=$CACHEBUST"

# Copy built output only
COPY --from=builder /workspace/apps/api/dist ./apps/api/dist

CMD ["node", "apps/api/dist/index.js"]
