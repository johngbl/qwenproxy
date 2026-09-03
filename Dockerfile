FROM mcr.microsoft.com/playwright:v1.62.1-jammy

# Upgrade Node.js to v24 (base image ships with Node 22)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install native build tools for better-sqlite3, plus process helpers.
# better-sqlite3 may compile from source on ARM64 when no prebuilt binary exists.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 dumb-init gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the application
COPY . .

# Prepare persistent directories and entrypoint
RUN mkdir -p /app/data/db /app/data/qwen_profiles /tmp/playwright \
  && chown -R pwuser:pwuser /app /tmp/playwright \
  && chmod +x /app/docker-entrypoint.sh

# Declare volume for persistent data (database, encryption key and browser profiles)
VOLUME ["/app/data"]

EXPOSE 7936
ENV NODE_ENV=production

# Use dumb-init to avoid zombie processes from Playwright and ensure writable volumes at startup
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
