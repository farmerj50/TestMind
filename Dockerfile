# -------------------------
# deps: install workspace deps (dev deps included for build)
# -------------------------
FROM node:20-bullseye-slim AS deps
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy root/workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/runner/package.json ./packages/runner/package.json

# Install with dev deps (needed for prisma + tsc during build)
ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false


# -------------------------
# builder: copy sources + build
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

# Bring installed deps forward
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/package.json ./package.json

# Copy actual sources
COPY apps/api ./apps/api
COPY packages/runner ./packages/runner

# Ensure workspace links are correct with full source present
ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false

# Build API
RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build


# -------------------------
# runner: install prod deps fresh + install Playwright browsers
# -------------------------
FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# ✅ Put Playwright browsers in a stable, image-owned path (not /root/.cache)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy manifests for prod install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/runner/package.json ./packages/runner/package.json

# Install ONLY production deps
RUN pnpm install --frozen-lockfile --prod

# Copy prisma schema + generate client in the runtime image
COPY apps/api/prisma ./apps/api/prisma
WORKDIR /app/apps/api
RUN pnpm exec prisma generate
WORKDIR /app

# ✅ Install Chromium + OS deps needed on Debian slim
# (Fixes: "Executable doesn't exist ... Please run npx playwright install")
RUN pnpm --filter api exec playwright install --with-deps chromium

# Copy built output
COPY --from=builder /workspace/apps/api/dist ./apps/api/dist

CMD ["node", "apps/api/dist/index.js"]
