# ================================================================
# STAGE 1: Build & Compile TypeScript
# ================================================================
FROM node:22-alpine AS builder
WORKDIR /app/server

# Install build tool dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps --prefer-offline

# Copy source files for compilation
COPY tsconfig.json ./
COPY index.ts db.ts redis.ts utils.ts bihrService.ts ./
COPY lib/ ./lib/
COPY chatbot/ ./chatbot/
COPY templates/ ./templates/
COPY schemas/ ./schemas/
COPY migrations/ ./migrations/

# Compile TypeScript to ./dist
RUN npm run build

# ================================================================
# STAGE 2: Production Execution Runtime
# ================================================================
FROM node:22-alpine AS runner
RUN apk add --no-cache wget curl unzip
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001

# System user & required persistent directories
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 backend
RUN mkdir -p /app/server/uploads /app/server/invoices /app/server/catalog-csv && \
    chown -R backend:nodejs /app/server

# Install production dependencies only
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps --omit=dev --prefer-offline && \
    chown -R backend:nodejs /app/server/node_modules

# Copy compiled JavaScript dist & assets from builder stage
COPY --chown=backend:nodejs --from=builder /app/server/dist ./dist
COPY --chown=backend:nodejs templates/ ./templates/
COPY --chown=backend:nodejs moto_catalog.json ./
COPY --chown=backend:nodejs catalog-csv.zip ./catalog-csv.zip

# Infra post-deploy hook
COPY --chown=root:root infra/escapes-post-deploy.sh /usr/local/bin/escapes-post-deploy.sh
RUN chmod +x /usr/local/bin/escapes-post-deploy.sh

USER backend
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3001/api/health || exit 1

CMD ["node", "dist/index.js"]
