FROM node:22-alpine AS builder
WORKDIR /app/server
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 backend
RUN mkdir -p /app/server/uploads /app/server/invoices && chown backend:nodejs /app/server/uploads /app/server/invoices
COPY --from=builder --chown=backend:nodejs /app/server/dist ./dist
COPY --from=builder --chown=backend:nodejs /app/server/node_modules ./node_modules
COPY --from=builder --chown=backend:nodejs /app/server/package.json ./package.json
COPY --from=builder --chown=backend:nodejs /app/server/moto_catalog.json ./moto_catalog.json
USER backend
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD wget -qO- http://localhost:3001/api/health || exit 1
CMD ["node", "dist/index.js"]
