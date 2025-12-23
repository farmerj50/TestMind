FROM node:20-bullseye-slim AS deps
WORKDIR /workspace
# Use Corepack to install a matching pnpm version without touching Node.js directly.
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ✅ add workspace package manifests (important for pnpm workspaces)
COPY apps/api/package.json ./apps/api/package.json
COPY packages/runner/package.json ./packages/runner/package.json
# add more packages/*/package.json if api depends on them

RUN pnpm install --frozen-lockfile

FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/package.json ./package.json
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile

# Install Linux dependencies so Playwright can run without invoking apt-get itself.
RUN apt-get update && apt-get install -y \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 libgdk-pixbuf2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
  libxrandr2 libxss1 libxtst6 xvfb xauth libgbm1 libpci3 libpangocairo-1.0-0 \
  libasound2 libxshmfence1 libdrm2 ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# ✅ generate Prisma client before TS build
RUN pnpm --filter api exec prisma generate

# ✅ install Playwright browsers so runners have the headless shells
RUN pnpm --filter api exec playwright install

RUN pnpm --filter api build

FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install Playwright/Chromium dependencies on Debian-based image.
RUN apt-get update && apt-get install -y \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 libgdk-pixbuf2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
  libxrandr2 libxss1 libxtst6 xvfb xauth libgbm1 libpci3 libpangocairo-1.0-0 \
  libasound2 libxshmfence1 libdrm2 ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/apps/api/dist ./dist
COPY --from=builder /workspace/apps/api/package.json ./package.json
COPY --from=builder /workspace/apps/api/prisma ./prisma
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /ms-playwright /ms-playwright

EXPOSE 8787

# Run server directly (migrations handled in CI)
CMD ["node", "dist/index.js"]
