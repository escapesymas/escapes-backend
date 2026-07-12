FROM node:22-alpine
RUN apk add --no-cache wget
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001
# No ARG/ENV with defaults - all config comes from Coolify env_file
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 backend
RUN mkdir -p /app/server/uploads /app/server/invoices && chown backend:nodejs /app/server/uploads /app/server/invoices
COPY --chown=backend:nodejs package.json ./
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
COPY --chown=backend:nodejs moto_catalog.json ./
RUN npm install --legacy-peer-deps --include=dev
USER backend
EXPOSE 3001
CMD ["npx", "tsx", "index.ts"]
