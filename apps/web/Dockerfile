# -------------------------
# builder: build Vite app
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy only the files needed to install deps for apps/web
# (If apps/web depends on workspace packages, we can add them later)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json

# Install deps (includes dev deps so vite exists)
ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false

# Copy web source
COPY apps/web apps/web

# Build
WORKDIR /workspace/apps/web
RUN pnpm run build


# -------------------------
# runner: nginx serving dist
# -------------------------
FROM nginx:alpine AS runner

# If you have a template file, nginx will envsubst it at startup
# (only needed if you're doing env var injection into config)
# If you do NOT have nginx.conf yet, create it at: apps/web/nginx.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built output
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
