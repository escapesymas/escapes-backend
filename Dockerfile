FROM node:22-alpine
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001
ENV DATABASE_URL=postgresql://escapes:EscapesCoolify2026!@hk6mt4abfh8ijg2vak6utvz2:5432/escapes_db
ENV JWT_SECRET=production-jwt-secret-change-me
ENV STRIPE_SECRET_KEY=sk_test_placeholder
ENV STRIPE_WEBHOOK_SECRET=whsec_placeholder
ENV REDIS_URL=redis://coolify-redis:6379
ENV API_URL=https://api.escapesymas.com
ENV FRONTEND_URL=https://escapesymas.com
ENV ADMIN_URL=https://admin.escapesymas.com
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD wget -qO- http://localhost:3001/api/health || exit 1
CMD ["npx", "tsx", "index.ts"]