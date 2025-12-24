# -------------------------
# build
# -------------------------
FROM node:20-bullseye-slim AS build
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9 --activate

# workspace manifests (pnpm needs these)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json

# if web imports workspace packages, add their package.json too:
# COPY packages/<name>/package.json ./packages/<name>/package.json

RUN pnpm install --frozen-lockfile --filter web...

COPY apps/web ./apps/web

RUN pnpm --filter web build


# -------------------------
# serve
# -------------------------
FROM nginx:alpine AS runner
WORKDIR /usr/share/nginx/html

COPY --from=build /workspace/apps/web/dist ./

# SPA routing
RUN printf 'server {\n\
  listen 80;\n\
  server_name _;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
