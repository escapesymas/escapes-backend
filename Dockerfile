FROM node:22-alpine
RUN apk add --no-cache wget curl unzip
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 backend
RUN mkdir -p /app/server/uploads /app/server/invoices /app/server/catalog-csv && chown backend:nodejs /app/server/uploads /app/server/invoices /app/server/catalog-csv

# Layer 1: Dependencies install (Cached across deployments when package.json is unchanged)
COPY --chown=backend:nodejs package.json ./
RUN --mount=type=cache,target=/root/.npm npm install --legacy-peer-deps --include=dev

# Layer 2: Copy source code files
COPY --chown=backend:nodejs tsconfig.json ./
COPY --chown=backend:nodejs index.ts ./
COPY --chown=backend:nodejs db.ts ./
COPY --chown=backend:nodejs redis.ts ./
COPY --chown=backend:nodejs utils.ts ./
COPY --chown=backend:nodejs bihrService.ts ./
COPY --chown=backend:nodejs chatbot/ ./chatbot/
COPY --chown=backend:nodejs templates/ ./templates/
COPY --chown=backend:nodejs lib/ ./lib/
COPY --chown=backend:nodejs schemas/ ./schemas/
COPY --chown=backend:nodejs migrations/ ./migrations/
COPY --chown=backend:nodejs scripts/ ./scripts/
COPY --chown=backend:nodejs moto_catalog.json ./
COPY --chown=backend:nodejs catalog-csv.zip ./catalog-csv.zip

COPY --chown=root:root infra/escapes-post-deploy.sh /usr/local/bin/escapes-post-deploy.sh
RUN chmod +x /usr/local/bin/escapes-post-deploy.sh

USER backend
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://localhost:3001/api/health || exit 1
CMD ["npx", "tsx", "index.ts"]
