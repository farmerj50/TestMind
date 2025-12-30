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

# ✅ Build-time Prisma generate (Prisma CLI exists here because dev deps are installed)
RUN pnpm --filter api exec prisma generate

# ✅ Build API
RUN pnpm --filter api build


# -------------------------
# runner: prod install (real deps) + playwright browsers
# -------------------------
FROM node:20-bullseye-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy manifests (include web manifest so pnpm workspace doesn't lstat fail)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/runner/package.json ./packages/runner/package.json

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# ✅ Copy generated Prisma client artifacts from builder
# This avoids needing Prisma CLI in the runtime image.
COPY --from=builder /workspace/apps/api/node_modules/.prisma /app/apps/api/node_modules/.prisma

# Install Playwright Chromium + OS deps into the final image
# NOTE: this requires Playwright to be present in prod deps of the filtered package.
RUN pnpm --filter api exec playwright install --with-deps chromium

ARG CACHEBUST=1
RUN echo "runner-cachebust=$CACHEBUST"

# Copy built output only
COPY --from=builder /workspace/apps/api/dist ./apps/api/dist

CMD ["node", "apps/api/dist/index.js"]
