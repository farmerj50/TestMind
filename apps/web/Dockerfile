# -------------------------
# builder: build the Vite app
# -------------------------
FROM node:20-bullseye-slim AS builder
WORKDIR /app

# enable pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json

# install deps needed to build web
RUN pnpm install --frozen-lockfile --filter ./apps/web... --prod=false

# copy web source
COPY apps/web ./apps/web

# build
RUN pnpm --dir apps/web run build

# -------------------------
# runner: nginx serves static dist
# -------------------------
FROM nginx:alpine AS runner

# Railway provides PORT; nginx listens on 80 by default.
# We'll use a template to make nginx listen on $PORT.
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template

# copy built assets
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

ENV PORT=8080
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
