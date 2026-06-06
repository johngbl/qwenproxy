FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

CMD ["npx", "tsx", "src/index.ts"]
