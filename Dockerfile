# ---- Build Stage ----
# Compile native addons (better-sqlite3) in a throwaway container
FROM node:22-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime Stage ----
FROM node:22-slim

# Process helpers (dumb-init for zombie reaping, gosu for user switching)
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init gosu \
  && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -r pwuser && useradd -r -g pwuser -m pwuser

WORKDIR /app

# Production deps with pre-compiled native modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Install Chromium + all its system deps via patchright (no Firefox/WebKit bloat)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx patchright install --with-deps chromium \
  && chown -R pwuser:pwuser /ms-playwright

# Application source and entrypoint
COPY docker-entrypoint.sh ./
COPY bin ./bin
COPY src ./src

# Prepare persistent directories
RUN mkdir -p /app/data/db /app/data/qwen_profiles /tmp/playwright \
  && chown -R pwuser:pwuser /app /tmp/playwright \
  && chmod +x /app/docker-entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 7936
ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
