FROM node:20-alpine AS deps
WORKDIR /workspace
RUN corepack enable && corepack pnpm env use --global 9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ✅ add workspace package manifests (important for pnpm workspaces)
COPY apps/api/package.json ./apps/api/package.json
COPY packages/runner/package.json ./packages/runner/package.json
# add more packages/*/package.json if api depends on them

RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /workspace

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /workspace/package.json ./package.json

COPY apps/api ./apps/api

# ✅ generate Prisma client before TS build
RUN pnpm --filter api exec prisma generate

RUN pnpm --filter api build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /workspace/apps/api/dist ./dist
COPY --from=builder /workspace/apps/api/package.json ./
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=builder /workspace/apps/api/prisma ./prisma

EXPOSE 8787
CMD ["node", "dist/index.js"]
