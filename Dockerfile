FROM node:20-slim

ENV NODE_ENV=production \
    PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      sqlite3 \
      unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY auth.js ./
COPY logger.js ./
COPY public ./public

VOLUME ["/app/books", "/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "server.js"]
