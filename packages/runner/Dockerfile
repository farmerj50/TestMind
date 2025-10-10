FROM mcr.microsoft.com/playwright:v1.47.2-jammy

RUN apt-get update && apt-get install -y git curl \
  && corepack enable && corepack prepare pnpm@9.12.2 --activate \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json pnpm-lock.yaml ./
COPY src ./src
RUN pnpm install --frozen-lockfile

ENTRYPOINT ["node", "src/index.js"]
