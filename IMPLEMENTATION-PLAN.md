# Plan de Implementación — EscapesYMas

> Plan consolidado de mejoras tras las optimizaciones de velocidad iniciales.
> Estado al 2026-08-10. Algunos elementos ya completados se marcan con ✅.

## ✅ Completado en esta sesión

### Backend
- **Endpoint `/api/bihr/sync-status`** con dashboard de progreso en tiempo real
- **Image downloader v2** (`scripts/download-missing-images.ts`) — dry-run OK, pero el endpoint `/Products/Image/{code}` de Bihr devuelve 404 para todos los productos en v2.1
- **Image downloader v3** (`scripts/download-images-from-catalog.ts`) — lee URLs desde el JSON del catálogo Bihr (`DefaultPicture` field en `api.mybihr.com`), soporta flags `--catalog=PATH` o `--fetch-catalog`
- **Bihr MACKEY corregido** — placeholder sustituido por la password real en Coolify DB + .env container
- **Vite env types** en admin (`src/vite-env.d.ts`)
- **Dockerfile** incluye `scripts/`

### Frontend
- **`.env.local`** apunta al backend VPS (`https://api.escapesymas.com`)
- Velocidad `/universales` medida: **0.21s en producción** (18× vs antes)

### Admin
- **SyncTab** conectado a v2/v3 endpoints con start/stop y polling del estado

## 🚧 En curso

### Descarga imágenes Bihr (98k productos HardPart)
- Catálogo `HardPart/Full` descargado (94MB JSON, 98k referencias, 95k con imagen)
- Problema detectado: productos con sku tipo `8002281` (ARAI, POLISPORT) NO están en HardPart → son RiderGear
- Esperando generación del catálogo RiderGear para mergear ambos
- Script v3 hace lookup por `sku` PRIMERO y `supplier_code` como fallback

### Pendiente inmediato
- Lanzar descarga real con batch=5000 concurrency=10 una vez RiderGear esté listo
- Verificar dashboard muestra progreso live
- Medir tiempo total: ~98k × 2-3s por producto ÷ 10 workers ≈ 8-12 horas

---

## 📋 Mejoras pendientes — agrupadas por prioridad

### 🔴 P0 — Crítico (esta semana)

#### 1. Completar descarga de imágenes Bihr
- **Estado**: HardPart listo. RiderGear pendiente de descarga
- **Acción**: mergear ambos catálogos, lanzar v3 con batch=5000 concurrency=10
- **Esfuerzo**: bajo (1 commit + ejecución)
- **Impacto**: 98k productos con imagen visible = SEO + conversión

#### 2. Monitoring en producción
- ✅ **Sentry backend** (`@sentry/node`) — captura 5xx, unhandled exceptions/rejections. Commit `64e1aad`. Activar con `SENTRY_DSN` en Coolify env vars.
- ⏳ **Sentry frontend** — pendiente (repo separado)
- **UptimeRobot** o **Better Stack** para monitorizar `https://api.escapesymas.com/api/health` cada 1 min
  - Alertas vía email/webhook si down > 2 min
- **Esfuerzo**: 2-3 horas
- **Impacto**: detección proactiva de caídas antes de que el cliente avise

#### 3. Backups automatizados PostgreSQL
- **Coolify** tiene backup automático pero verificarlo
- Cron `pg_dump` diario → S3 / Backblaze B2
- Retention: 7 días daily, 4 semanas weekly
- **Esfuerzo**: 1 hora
- **Impacto**: recuperación ante disaster

### 🟡 P1 — Importante (próximas 2 semanas)

#### 4. Bundle analyzer
- `npm i @next/bundle-analyzer` en frontend
- Añadir script `analyze` que abre el mapa visual
- Identificar librerías pesadas (`@stripe/react-stripe-js` pesa ~80kB gzip)
- **Esfuerzo**: 30 min
- **Impacto**: visibilidad de qué meter en lazy chunks

#### 5. Prefetch on hover en catálogo
- Next.js 16 ya tiene prefetch automático en `<Link>`
- Mejora: hover-triggered prefetch para que el click sea instantáneo
- Implementar custom hook `useHoverPrefetch(href)`
- Aplicar a `/producto/[slug]` y `/universales/[cat]`
- **Esfuerzo**: 4 horas
- **Impacto**: navegación percibida como instantánea

#### 6. CDN para imágenes de productos
- Las imágenes WebP están en `/app/server/uploads/optimized/`
- Mover a **Cloudflare Images** o **Bunny CDN** para servir desde edge
- Reescribir URLs en backend al generar las variantes
- **Esfuerzo**: 6 horas (incluye migración)
- **Impacto**: TTFB de imagen < 50ms en cualquier país

#### 7. Stripe webhook reliability
- Verificar idempotency en `/api/stripe/webhook`
- Logging detallado de eventos
- Retry queue para webhooks fallidos
- **Esfuerzo**: 3 horas
- **Impacto**: cero pagos perdidos

#### 8. Stock sync automático desde Bihr
- Cron cada 6h: actualizar `products.stock` desde Bihr Inventory API
- Solo productos activos con `dropshipping=true` o `ondemand=true`
- **Esfuerzo**: 4 horas
- **Impacto**: stock siempre actual, evita vender lo que no hay

### 🟢 P2 — Deseable (próximo mes)

#### 9. Caché de imágenes generadas
- Endpoint `/api/products/[id]/image` que:
  - Si WebP existe en disco → serve
  - Si no → genera on-the-fly desde URL de Bihr + cachea
- **Esfuerzo**: 4 horas
- **Impacto**: sitio funciona aunque no se haya completado la descarga inicial

#### 10. Search con Meilisearch o Typesense
- Indexar productos en búsqueda full-text
- Búsqueda fuzzy por sku, nombre, marca
- Drop-in replacement del `/api/products?search=`
- **Esfuerzo**: 8 horas
- **Impacto**: UX de búsqueda muchísimo mejor

#### 11. PWA / Service Worker
- Cachear assets estáticos
- Offline fallback para páginas de categorías
- **Esfuerzo**: 6 horas
- **Impacto**: sitio usable sin red, mejor LCP en visitas repetidas

#### 12. Email transaccional robusto
- Verificar que Nodemailer usa SMTP con retry
- Templates de email en MJML para mantenimiento fácil
- Tracking de apertura con pixel transparente (opcional)
- **Esfuerzo**: 3 horas
- **Impacto**: emails nunca en spam, mejor deliverability

#### 13. Tests E2E en CI
- Playwright ya configurado en frontend (`playwright.config.ts`)
- Añadir CI en GitHub Actions: build → start → test
- **Esfuerzo**: 2 horas
- **Impacto**: detección automática de regresiones

#### 14. Admin: filtros y orden en products
- SyncTab es el más complejo del admin
- Mejorar búsqueda con debounce
- Paginación server-side (ahora es client-side)
- **Esfuerzo**: 4 horas
- **Impacto**: admin más usable con 100k productos

#### 15. Lighthouse score 95+ en mobile
- Audit actual: ~75 (probable)
- Optimizaciones: font-display: swap, image lazy load, defer non-critical JS
- **Esfuerzo**: 6 horas
- **Impacto**: SEO boost, mejor ranking Google

### 🔵 P3 — Nice to have (backlog)

- Internacionalización (català, euskara, galego además de español)
- Reviews de productos por clientes verificados
- Wishlist persistente por usuario
- Comparador de productos (lado a lado)
- Integración con Instagram shop
- Programa de fidelización / puntos
- Dashboard analytics en admin (conversión, AOV, LTV)
- Webhooks de Stripe → n8n para automatización
- Chatbot mejorado con OpenAI Assistants API
- Modo multi-idioma del chatbot

---

## 🎯 Orden de ejecución recomendado

```
Semana 1: P0 (imágenes + monitoring + backups)
Semana 2: P1.4 (bundle) + P1.5 (prefetch hover) + P1.7 (Stripe webhook)
Semana 3: P1.6 (CDN imágenes) + P1.8 (stock sync)
Semana 4: P2.9 (image cache) + P2.13 (CI tests)
Mes 2: P2.10 (Meilisearch) + P2.14 (admin) + P2.15 (Lighthouse)
```

## 📊 Métricas de éxito

| Métrica | Actual | Objetivo |
|---------|--------|----------|
| /universales TTFB | 0.21s | < 0.15s |
| Productos con imagen | ~15k | 98k |
| Lighthouse mobile | ~75 | 95+ |
| Uptime | unknown | 99.9% |
| Errores JS en producción | unknown | < 0.1% sesiones |
| Bundle inicial (gzip) | unknown | < 150kB |

---

## 🔧 Stack técnico actual

- **Frontend**: Next.js 16.2.6 (Turbopack) + React 19 + Tailwind 4
- **Backend**: Express + TypeScript + Drizzle ORM + PostgreSQL + Redis
- **Admin**: Vite + React 18 + Tailwind 3 + SWR
- **Image processing**: Sharp (WebP 800/400/200)
- **Cache**: Redis (Catálogo, Vehicles, Filtros)
- **Auth**: bcrypt + JWT
- **Payments**: Stripe (live keys)
- **Email**: Nodemailer
- **Pagos B2B**: Bihr API v2.1
- **Deploy**: Coolify (Traefik proxy, Docker)
- **DB**: PostgreSQL 16

---

## 📝 Notas

- El usuario dio feedback: "el frontend local deberia apuntar al backend del vps" → ✅ hecho
- El usuario dio feedback: "la mackey es la password" → ✅ aplicado
- Frontend está en directorio `FRONTEND/` dentro de `escapes-react/` (no raíz)
- Admin es repo separado `escapes-admin`
- Backend tiene `CLEANUP.md` y `DEPLOY.md` con procedimientos
- Sistema de despliegue manual: `sed -i 's|image:old|image:new|' docker-compose.yaml && docker compose up -d --force-recreate` bypassa la cola de Coolify