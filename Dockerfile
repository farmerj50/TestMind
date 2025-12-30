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

ARG CACHEBUST=173
RUN echo "cachebust=$CACHEBUST"

COPY apps/api ./apps/api
COPY packages/runner ./packages/runner

ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false

# ✅ Generate Prisma client in builder (keeps build consistent)
RUN pnpm --filter api exec prisma generate

# ✅ Build API
RUN pnpm --filter api build

# ✅ Install Playwright browsers only (no OS deps here)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter api exec playwright install chromium


# -------------------------
# runner: prod deps + runtime only
# -------------------------
FROM node:20-bullseye-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ✅ Install runtime OS deps (including Playwright/Chromium deps) with retries
RUN set -eux; \
  for i in 1 2 3; do \
    apt-get update && break || sleep 5; \
  done; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    openjdk-17-jre-headless \
    ca-certificates \
    curl \
    wget \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0 \
    libxshmfence1 \
    libxkbcommon0 \
    libcups2 \
    libdrm2 \
    libxfixes3 \
    libpango-1.0-0 \
    libcairo2 \
    libxext6 \
    libx11-6 \
    libxcb1 \
    libxkbfile1 \
    libxrender1 \
    libxi6 \
    libxtst6 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/runner/package.json ./packages/runner/package.json

# ✅ Install prod deps for the api workspace (THIS fixes @prisma/client resolution)
RUN pnpm --filter api... install --frozen-lockfile --prod

# Prisma schema needed for generate
COPY --from=builder /workspace/apps/api/prisma /app/apps/api/prisma

# ✅ Generate Prisma client in runtime (matches runtime pnpm layout)
RUN pnpm --filter api exec prisma generate

# ✅ Copy Playwright browsers from builder
COPY --from=builder /ms-playwright /ms-playwright

ARG CACHEBUST=173
RUN echo "runner-cachebust=$CACHEBUST"

# Copy built output only
COPY --from=builder /workspace/apps/api/dist ./apps/api/dist

CMD ["node", "apps/api/dist/index.js"]
