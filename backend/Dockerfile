# syntax=docker/dockerfile:1

# ─── Stage 1: production-only dependencies ────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# BuildKit cache mount: npm's download cache survives across builds but is never
# written into an image layer. If an install ever needs a registry token, mount
# it with `--mount=type=secret,id=npmrc,target=/root/.npmrc` — never ARG/ENV/COPY.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ─── Stage 2: TypeScript build + Prisma client generation ────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
# Source layers come after the dependency install, so a code-only change reuses
# the cached node_modules layer above until package-lock.json changes.
COPY tsconfig.json ./
COPY prisma/ ./prisma/
COPY src/ ./src/
RUN npm run build && npx prisma generate

# ─── Stage 3: lean production image ──────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache postgresql-client \
 && addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 appuser

# Production node_modules (no dev deps)
COPY --from=deps    --chown=appuser:nodejs /app/node_modules           ./node_modules
# Prisma-generated query engine + client (not present in deps stage)
COPY --from=builder --chown=appuser:nodejs /app/node_modules/.prisma   ./node_modules/.prisma
# Compiled JavaScript
COPY --from=builder --chown=appuser:nodejs /app/dist                   ./dist
# Prisma schema (required for migrate deploy at container start)
COPY --chown=appuser:nodejs prisma/    ./prisma/
COPY --chown=appuser:nodejs package.json   ./
COPY --chown=appuser:nodejs scripts/   ./scripts/

USER appuser
EXPOSE 4000
CMD ["node", "dist/index.js"]
