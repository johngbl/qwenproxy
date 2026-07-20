FROM mcr.microsoft.com/playwright:v1.61.1-jammy

# Install dumb-init to handle process signals correctly and gosu for privilege drop
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init gosu && rm -rf /var/lib/apt/lists/*

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

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

# Use dumb-init to avoid zombie processes from Playwright and ensure writable volumes at startup
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
