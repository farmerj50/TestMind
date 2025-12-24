# -------------------------
# builder: build Vite app
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/package.json

ENV NPM_CONFIG_PRODUCTION=false
RUN pnpm install --frozen-lockfile --prod=false

COPY apps/web ./apps/web

# ---- Build-time Vite envs (REQUIRED for Vite) ----
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_API_URL
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_API_URL=$VITE_API_URL
# --------------------------------------------------

WORKDIR /workspace/apps/web
RUN pnpm run build


# -------------------------
# runner: nginx serving dist
# -------------------------
FROM nginx:alpine AS runner

# Ensure envsubst exists
RUN apk add --no-cache gettext

ENV PORT=8080

# Copy template
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template

# Copy built output
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html

EXPOSE 8080

# Substitute ${PORT} then start nginx
CMD ["/bin/sh", "-c", "envsubst '$$PORT' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
