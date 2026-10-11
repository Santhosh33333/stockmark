# TradeMind — production image (free-tier friendly).
# Node 24 provides the built-in `node:sqlite`, so there is no native build step.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=5124 \
    HOST=0.0.0.0

WORKDIR /app

# Dependencies first (cached layer). A lockfile is committed, so use `npm ci`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Application source (see .dockerignore for exclusions).
COPY . .

# SQLite DB + universe cache live here. Mount a volume at /app/data (or point
# DATA_DIR elsewhere) to keep them across restarts and redeploys.
VOLUME ["/app/data"]

EXPOSE 5124
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5124)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
