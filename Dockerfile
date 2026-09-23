# syntax=docker/dockerfile:1

# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

# ─── Stage 2: Pruner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS pruner

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ─── Stage 3: Runner ──────────────────────────────────────────────────────────
FROM node:22-slim AS runner

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
  git ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

# The opencode CLI is only needed when AI_RUNNER=opencode; opt in with
# --build-arg INSTALL_OPENCODE=true (pin OPENCODE_VERSION for reproducible builds).
ARG INSTALL_OPENCODE=false
ARG OPENCODE_VERSION=latest
RUN if [ "$INSTALL_OPENCODE" = "true" ]; then \
    npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force; \
  fi

RUN groupadd -r appgroup && useradd -r -m -d /home/appuser -g appgroup appuser

WORKDIR /app

COPY --from=pruner --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --chown=appuser:appgroup package.json ./

RUN mkdir -p /workspace && chown appuser:appgroup /workspace

USER appuser

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

EXPOSE 3000

# HEALTHCHECK is defined in docker-compose.yml for the api service only.
# The worker doesn't serve HTTP, so it has no healthcheck.