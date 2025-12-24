# -------------------------
# builder: build Vite app
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy only the files needed to install deps for apps/web
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/package.json

# Install deps (include dev deps so Vite build works)
ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false

# Copy web source
COPY apps/web ./apps/web

# Build
WORKDIR /workspace/apps/web
RUN pnpm run build


# -------------------------
# runner: nginx serving dist
# -------------------------
FROM nginx:alpine AS runner

# Railway injects PORT at runtime; default for local/container runs
ENV PORT=8080

# Copy nginx template (expects you to create apps/web/nginx.conf.template)
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template

# Copy built output
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html

# Informational only, but keep consistent
EXPOSE 8080

# Render template -> actual config, then start nginx
CMD ["/bin/sh", "-c", "envsubst '$$PORT' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
