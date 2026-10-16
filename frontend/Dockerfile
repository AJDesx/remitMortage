# syntax=docker/dockerfile:1
# =============================================================================
# Stage 1 — deps
# Install *all* node_modules (including devDependencies) so the build stage
# has everything it needs.  We pin the exact Node version used in CI to keep
# the layer cache stable.
# =============================================================================
FROM node:20.19-alpine AS deps

# libc6-compat is required for some native Node addons on Alpine.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy manifests first so Docker layer-caching skips the install when only
# source files change.
COPY package.json package-lock.json* ./

# Install with a frozen lockfile — fails fast if lock is stale rather than
# silently upgrading packages.
# BuildKit cache mount keeps npm's download cache out of the image layers.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --frozen-lockfile


# =============================================================================
# Stage 2 — builder
# Compile the Next.js application in production mode and emit a standalone
# output bundle (.next/standalone) that contains only the files needed to
# run the server at runtime.
# =============================================================================
FROM node:20.19-alpine AS builder

RUN apk add --no-cache libc6-compat

WORKDIR /app

# Bring in the full node_modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy all source files.
COPY . .

# Disable Next.js telemetry inside the build container.
ENV NEXT_TELEMETRY_DISABLED=1

# Build the application.  next.config.ts sets `output: "standalone"` which
# produces:
#   .next/standalone/   — minimal Node.js server + bundled node_modules
#   .next/static/       — hashed static assets (JS, CSS, images)
#   public/             — unprocessed public assets
RUN npm run build


# =============================================================================
# Stage 3 — runner  (production image)
# Copy only the artifacts produced by the builder — no source code, no dev
# dependencies, no build toolchain.  The final layer is as small as possible.
# =============================================================================
FROM node:20.19-alpine AS runner

RUN apk add --no-cache libc6-compat

# Security hardening: run as a non-root user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

WORKDIR /app

# Disable telemetry at runtime too.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# The standalone server expects static assets to be served from these paths.
# Copy them explicitly — they are NOT included in .next/standalone automatically.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The standalone bundle: a self-contained Node server with only the production
# dependencies it actually uses, pre-bundled by the Next.js trace step.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

USER nextjs

# Next.js standalone server listens on PORT (default 3000).
EXPOSE 3000
ENV PORT=3000
# Bind to all interfaces so the container port is reachable from the host.
ENV HOSTNAME=0.0.0.0

# server.js is the entrypoint emitted by `output: "standalone"`.
CMD ["node", "server.js"]
