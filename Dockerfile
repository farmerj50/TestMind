# -------------------------
# deps: install workspace deps (dev deps included for build)
# -------------------------
FROM node:20-bullseye-slim AS deps
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/runner/package.json ./packages/runner/package.json

ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false


# -------------------------
# builder: build API + generate prisma + install playwright browsers
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

# Keep browsers in image-owned path
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NPM_CONFIG_PRODUCTION=false

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/package.json ./package.json

COPY apps/api ./apps/api
COPY packages/runner ./packages/runner

# ensure workspace links are correct with full source present
RUN pnpm install --frozen-lockfile --prod=false

# prisma client + api build
RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build

# ✅ install chromium + deps during build (so runner doesn't need pnpm)
RUN pnpm --filter api exec playwright install --with-deps chromium


# -------------------------
# runner: minimal runtime (no pnpm commands, no workspace scanning)
# -------------------------
FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy only runtime bits
COPY --from=builder /workspace/apps/api/dist ./apps/api/dist
COPY --from=builder /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=builder /workspace/apps/api/prisma ./apps/api/prisma

# Copy node_modules from builder (already linked & includes prisma client output)
COPY --from=builder /workspace/node_modules ./node_modules

# Copy Playwright browsers
COPY --from=builder /ms-playwright /ms-playwright

CMD ["node", "apps/api/dist/index.js"]
