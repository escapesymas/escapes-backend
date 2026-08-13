---
name: escapesymas-infra-reference
description: "Complete infrastructure reference: VPS, Coolify, GitHub, domains, DNS, credentials locations, and deployment notes"
metadata:
  type: reference
  originSessionId: 44ffba2c-473a-4d4e-bdf9-7df2da581bd0
  modified: 2026-08-12T17:54:35.570Z
---

# escapesymas.com — Infrastructure Reference

## VPS

- **IP**: `212.227.134.161`
- **SSH**: `ssh -i ~/.ssh/id_ed25519 root@212.227.134.161`
- **Key**: `~/.ssh/id_ed25519` (local, NOT `/home/adrian/Descargas/id_ed25519`)
- **OS**: Linux (managed via SSH directly, no control panel)

## Docker / Coolify

Coolify is **self-hosted** on the VPS. The Coolify panel UI (`https://coolify.escapesymas.com`) is currently broken (returns 503 "no available server" at the edge). Operations must be done via SSH to the VPS.

**Coolify data root**: `/data/coolify/`

Each application lives at `/data/coolify/applications/<UUID>/` with:
- `docker-compose.yaml` — container definition and labels
- `.env` — environment variables (credentials, API keys, etc.)

### Application UUIDs

| App | UUID | Repo |
|---|---|---|
| escapes-admin | `tg1dkuljg665aer4aqk26500` | escapes-admin |
| escapes-backend | `wg90ssxowlynpipdyxil35lw` | escapes-backend |
| escapes-frontend | `k11bvrk0fa8e83hg4i61e4w3` | escapes-react |
| escapes-umami | (standalone) | umami |
| jumpseller-sync | `jze7jlqi5ony7waqr2j5asbx` | jumpseller-sync |

### Container naming convention

```
<uuid>-<random-suffix>  # Coolify-generated random suffix on each deploy
```

Example: `wg90ssxowlynpipdyxil35lw-081319813925`

### Container health states

- `healthy` → serving traffic, all good
- `Up X minutes` (no healthy) → still starting OR no healthcheck defined (nginx-based containers like escapes-admin don't have a healthcheck configured — they are healthy when logs show nginx is running)
- `unhealthy` → sidecar or secondary container, may be normal

### Manual Docker operations

```bash
# List containers by image tag
docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}"

# View container logs
docker logs --tail 50 <container-name>

# Restart a container
docker restart <container-name>

# Inspect container networks/aliases
docker inspect <container-name> --format "{{range .NetworkSettings.Networks}}{{.Aliases}} -> {{.IPAddress}}{{end}}"
```

## GitHub

| Repo | URL |
|---|---|
| escapes-backend | git@github.com:escapesymas/escapes-backend.git |
| escapes-admin | git@github.com:escapesymas/escapes-admin.git |
| escapes-react | git@github.com:escapesymas/escapes-react.git (frontend) |

**SSH auth**: `gh auth status` — authenticated as `escapesymas`

## Domains & DNS

| Host | Type | Target |
|---|---|---|
| `escapesymas.com` | A | `212.227.134.161` (via Plesk) |
| `www.escapesymas.com` | CNAME | `escapesymas.com` |
| `api.escapesymas.com` | CNAME | `escapesymas.com` |
| `admin.escapesymas.com` | CNAME | `escapesymas.com` |
| `umami.escapesymas.com` | CNAME | `escapesymas.com` |

DNS provider: Managed via the VPS directly (no control panel)

## Traefik Reverse Proxy

The VPS runs **Traefik** as `coolify-proxy` container. It handles HTTPS termination and routing for all subdomains.

**Static config**: `/data/coolify/proxy/dynamic/http.yaml`

### Current static routing (what's in http.yaml)

Only `escapes-backend` and `escapes-frontend-www` are in static config. Everything else (admin, umami) uses docker provider labels from their `docker-compose.yaml`.

```yaml
http:
  routers:
    escapes-backend:
      rule: "Host(`api.escapesymas.com`)"
      service: escapes-backend
      tls: { certResolver: letsencrypt }
    escapes-frontend-www:
      rule: "Host(`www.escapesymas.com`)"
      service: escapes-frontend
      tls: { certResolver: letsencrypt }
  services:
    escapes-backend:
      loadBalancer:
        servers: [{url: "http://backend:3001"}]
    escapes-frontend:
      loadBalancer:
        servers: [{url: "http://k11bvrk0fa8e83hg4i61e4w3-<suffix>:3000"}]
```

### IMPORTANT routing rules

1. **Do NOT add `escapes-admin` to static http.yaml** pointing to `coolify-proxy:80`. The proxy container itself has Docker aliases `admin` and `escapes-admin`, so that creates an infinite loop → 502.
2. **admin.escapesymas.com** must be handled by docker-compose labels only (Coolify generates those automatically).
3. **www.escapesymas.com** is handled by static config because the frontend container uses a different network alias that static config can reach.
4. **api.escapesymas.com** is handled by static config pointing to `http://backend:3001` (Docker DNS resolves `backend` alias to the current healthy container).

### When a container redeploys

After Coolify redeploys, container name suffixes change. If static config points to a specific suffix (like the frontend), you must update `http.yaml`:

```bash
# Find the new container name
docker ps --format "{{.Names}}\t{{.Image}}" | grep escapes-frontend

# Edit http.yaml with the new name
vi /data/coolify/proxy/dynamic/http.yaml
docker restart coolify-proxy
```

## Credential locations

| Credential | Location |
|---|---|
| **Database URL** | `/data/coolify/applications/wg90ssxowlynpipdyxil35lw/.env` → `DATABASE_URL` |
| **Bihr API (MAC key)** | Same `.env` → `BIHR_MACKEY` |
| **Bihr username** | `BIHR_USERNAME` (same `.env`, defaults to `info@escapesymas.com`) |
| **Stripe keys** | Frontend `.env` / Coolify env vars |
| **JWT secret** | Backend `.env` → `JWT_SECRET` |
| **Admin credentials** | Not in any `.env` — hardcoded in backend DB (`users` table). Login: `info@escapesymas.com` / `Pedrito2011P!` |

## Environment variables for each app

### escapes-backend (wg90ssxowlynpipdyxil35lw)
Key vars in `/data/coolify/applications/wg90ssxowlynpipdyxil35lw/.env`:
- `DATABASE_URL` — PostgreSQL connection string
- `BIHR_MACKEY` — Bihr API key
- `BIHR_USERNAME` — `info@escapesymas.com`
- `BIHR_API_BASE` — `https://api.bihr.net`
- `JWT_SECRET` — session signing
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `FRONTEND_URL` — `https://escapesymas.com`

### escapes-admin (tg1dkuljg665aer4aqk26500)
Static SPA served by nginx. No server-side env vars needed (auth is against backend API).

### escapes-react / frontend (k11bvrk0fa8e83hg4i61e4w3)
Key vars in its `.env`:
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_API_URL` — `https://api.escapesymas.com`
- `UMAMI_WEBSITE_ID`

## Services

### Backend API
- **URL**: `https://api.escapesymas.com`
- **Health**: `https://api.escapesymas.com/api/health`
- **Auth**: POST `/api/auth?action=login` with `{"username":"email","password":"..."}`
- **Admin**: `/api/admin?action=...` (requires `Authorization: Bearer <token>`)

### Bihr Integration
- **API Base**: `https://api.bihr.net`
- **Auth**: POST `/api/v2.1/Authentication/Token` (form-urlencoded: `UserName`, `PassWord`)
- **Token caching**: 30 min TTL in memory
- **Stock**: GET `/api/v2.1/Inventory/StockLevel?productCode=...` and `/api/v2.1/Inventory/StockValue?productCode=...`
- **Timeouts**: 10s for auth, 8s for stock calls (via `AbortSignal.timeout`)

### Umami Analytics
- **URL**: `https://umami.escapesymas.com`
- **Admin**: `https://umami.escapesymas.com/share/<token>/<site-name>`
- **Admin credentials**: `admin@escapesymas.com` / `Umami2026!AdminSecure`
- **Website IDs** (in Umami settings):
  - escapesymas.com: UUID stored in frontend env

### Database (PostgreSQL)
- **Access**: On VPS host, port 5432 (from `hk6mt4abfh8ijg2vak6utvz2` container or directly via host if configured)
- **Credentials**: In backend `.env` → `DATABASE_URL`

## Common Issues & Fixes

### 502 on a subdomain
Usually a routing loop or DNS resolution failure. Check:
1. Is the container running and healthy?
2. Does the static `http.yaml` point to the correct service?
3. Is there a docker-compose label also handling the same host (double router conflict)?
4. Does the `coolify-proxy` container have the right network aliases?

### Backend hangs / all requests timeout
Usually caused by `await` calls to external services (Bihr, Stripe, etc.) without timeouts.
- All external fetch calls MUST use `AbortSignal.timeout()`
- Bihr auth: 10s timeout
- Bihr stock calls: 8s timeout

### Coolify API broken (503)
Can't use the UI. Manage containers directly via `docker` commands on the VPS.

### Container not pulling new image after git push
Sometimes Coolify's image pull is slow or fails silently. Force a redeploy via:
```bash
docker pull <new-image>
docker stop <old-container>
docker rm <old-container>
# Let Coolify restart it, or manually:
docker run -d --name <new-container> <image>
```

## Useful one-liners

```bash
# SSH to VPS
ssh -i ~/.ssh/id_ed25519 -o BatchMode=yes root@212.227.134.161

# List all escapes containers
ssh root@... 'docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "escapes|wg90ssx|k11bvr|tg1dkul|umami"'

# Tail backend logs
ssh root@... 'docker logs --tail 100 -f $(docker ps --format "{{.Names}}" | grep wg90ssx | grep healthy | head -1)'

# Check API health
curl -s https://api.escapesymas.com/api/health

# Force-restart backend (when hung)
ssh root@... 'docker restart $(docker ps --format "{{.Names}}" | grep wg90ssx | grep healthy | head -1)'

# Check Traefik logs
ssh root@... 'docker logs --tail 50 coolify-proxy'

# Reload Traefik static config
ssh root@... 'docker restart coolify-proxy'
```
