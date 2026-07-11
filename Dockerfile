FROM node:22-alpine
WORKDIR /app/server
ENV NODE_ENV=production PORT=3001
ARG DATABASE_URL=postgresql://escapes:EscapesCoolify2026!@hk6mt4abfh8ijg2vak6utvz2:5432/escapes_db
ENV DATABASE_URL=${DATABASE_URL}
ARG JWT_SECRET=production-jwt-secret-change-me
ENV JWT_SECRET=${JWT_SECRET}
ARG STRIPE_SECRET_KEY=sk_test_placeholder
ENV STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
ARG STRIPE_TEST_SECRET_KEY=sk_test_placeholder
ENV STRIPE_TEST_SECRET_KEY=${STRIPE_TEST_SECRET_KEY}
ARG STRIPE_WEBHOOK_SECRET=whsec_placeholder
ENV STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
ARG STRIPE_TEST_WEBHOOK_SECRET=whsec_test_placeholder
ENV STRIPE_TEST_WEBHOOK_SECRET=${STRIPE_TEST_WEBHOOK_SECRET}
ARG REDIS_URL=redis://coolify-redis:6379
ENV REDIS_URL=${REDIS_URL}
ARG API_URL=https://api.escapesymas.com
ENV API_URL=${API_URL}
ARG FRONTEND_URL=https://escapesymas.com
ENV FRONTEND_URL=${FRONTEND_URL}
ARG ADMIN_URL=https://admin.escapesymas.com
ENV ADMIN_URL=${ADMIN_URL}
ARG SMTP_HOST=smtp.buzondecorreo.com
ENV SMTP_HOST=${SMTP_HOST}
ARG SMTP_PORT=465
ENV SMTP_PORT=${SMTP_PORT}
ARG SMTP_USER=web@escapesymas.com
ENV SMTP_USER=${SMTP_USER}
ARG SMTP_PASSWORD=placeholder
ENV SMTP_PASSWORD=${SMTP_PASSWORD}
ARG WP_URL=https://backendescapes.com
ENV WP_URL=${WP_URL}
ARG WOO_KEY=placeholder
ENV WOO_KEY=${WOO_KEY}
ARG WOO_SECRET=placeholder
ENV WOO_SECRET=${WOO_SECRET}
ARG BIHR_API_BASE=https://api.bihr.net
ENV BIHR_API_BASE=${BIHR_API_BASE}
ARG BIHR_USERNAME=info@escapesymas.com
ENV BIHR_USERNAME=${BIHR_USERNAME}
ARG BIHR_MACKEY=placeholder
ENV BIHR_MACKEY=${BIHR_MACKEY}
ARG JWT_ADMIN_SECRET=change-this-to-a-long-random-string
ENV JWT_ADMIN_SECRET=${JWT_ADMIN_SECRET}
ARG MINIMAX_API_KEY=placeholder
ENV MINIMAX_API_KEY=${MINIMAX_API_KEY}
ARG ADMIN_KEY=escapes-admin-sync-key-2026-change-me
ENV ADMIN_KEY=${ADMIN_KEY}
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