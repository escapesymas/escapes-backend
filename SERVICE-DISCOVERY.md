# Service Discovery Guide: Traefik + Docker DNS

This document explains how to move away from manual edits to the VPS-side
Traefik dynamic configuration (`/data/coolify/proxy/dynamic/http.yaml`) and
toward label-driven, Docker-native service discovery.

## The Problem Today

Every time the backend container is replaced (rebuilt, redeployed, restarted
on a new node), the upstream URL hardcoded in Traefik's dynamic file
(`http://backend:3001`) drifts and must be patched by hand on the VPS:

- File: `/data/coolify/proxy/dynamic/http.yaml`
- The `service.loadbalancer.server.url` is hardcoded to
  `http://backend:3001`.
- When the container ID changes, the Docker DNS name still resolves, but
  the connection breaks if the alias is missing on the right network or if
  the port changes.

The frontend (`escapes-react/FRONTEND/next.config.ts`) and the admin
(`escapes-admin/nginx.conf`) also hardcode URLs like
`https://api.escapesymas.com` or `http://backend:3001` in their rewrites /
proxy_pass directives.

## The Recommended Solution

Use **Docker DNS service discovery** through Coolify's network aliasing plus
**Traefik Docker labels** so that routing is described declaratively next to
each service rather than imperatively in a single VPS file.

Key building blocks:

1. **The `coolify` Docker network** — every Coolify-managed container is
   attached to this network. Containers can reach each other by their
   service name or by stable aliases registered on the network.
2. **Coolify `Aliases`** — assign stable network aliases (`backend`,
   `escapes-backend`, etc.) on the `coolify` network so a service is always
   reachable at the same DNS name regardless of the container ID.
3. **Traefik Docker provider with label-based routing** — Traefik watches
   the Docker socket, reads `traefik.*` labels from running containers, and
   builds routers/services dynamically. No more editing
   `/data/coolify/proxy/dynamic/http.yaml` by hand.

### Why this works

- Traefik discovers services from container labels automatically.
- Container restarts, image rebuilds, and rollbacks do not break routing:
  the label stays with the (new) container.
- Coolify keeps a stable alias (`backend`) on the `coolify` network, so the
  in-network DNS name survives container replacement.

## Traefik Labels per Service

Apply these labels in Coolify's "Service Labels" / compose override UI for
each container. The crucial extra label is
`traefik.docker.network=coolify` so Traefik uses the right network to
resolve the service.

### Backend (`escapes-backend`, host = `api.escapesymas.com`)

```
traefik.enable=true
traefik.docker.network=coolify
traefik.http.routers.escapes-backend.rule=Host(`api.escapesymas.com`)
traefik.http.routers.escapes-backend.entrypoints=https
traefik.http.routers.escapes-backend.tls=true
traefik.http.routers.escapes-backend.tls.certresolver=letsencrypt
traefik.http.services.escapes-backend.loadbalancer.server.port=3001
```

Network alias to set on the `coolify` network in Coolify: `backend`.

### Frontend (`escapes-react/FRONTEND`, host = `escapesymas.com`)

```
traefik.enable=true
traefik.docker.network=coolify
traefik.http.routers.escapes-frontend.rule=Host(`escapesymas.com`)
traefik.http.routers.escapes-frontend.entrypoints=https
traefik.http.routers.escapes-frontend.tls=true
traefik.http.routers.escapes-frontend.tls.certresolver=letsencrypt
traefik.http.services.escapes-frontend.loadbalancer.server.port=3000
```

If `www.escapesymas.com` should also resolve, add a second router that
mirrors the above and uses `traefik.http.routers.escapes-frontend-www.rule`
or include it in the same rule:
`Host(`escapesymas.com`, `www.escapesymas.com`)`.

### Admin (`escapes-admin`, host = `admin.escapesymas.com`)

```
traefik.enable=true
traefik.docker.network=coolify
traefik.http.routers.escapes-admin.rule=Host(`admin.escapesymas.com`)
traefik.http.routers.escapes-admin.entrypoints=https
traefik.http.routers.escapes-admin.tls=true
traefik.http.routers.escapes-admin.tls.certresolver=letsencrypt
traefik.http.services.escapes-admin.loadbalancer.server.port=80
```

(The admin image is `nginx:alpine` with `EXPOSE 80`.)

## How to Configure This in Coolify

For each service (`escapes-backend`, `escapes-frontend`, `escapes-admin`):

1. Open the resource in Coolify.
2. Go to **Configuration** -> **Service Labels** (or the compose override
   field).
3. Paste the labels above for that service.
4. In **Networking** -> **Aliases** on the `coolify` network, add:
   - `backend` for `escapes-backend`
   - `frontend` (optional) for the frontend container
   - `admin` (optional) for the admin container
5. Save. Coolify redeploys the container; Traefik picks up the labels and
   builds the router/service automatically.
6. Verify: `docker exec coolify-proxy wget -qO- http://backend:3001/api/health`
   should return 200 from inside the Traefik container on the `coolify`
   network.

## What to Do With the Old Hardcoded URLs

After the labels are in place and TLS is provisioned by Traefik:

- Frontend `next.config.ts` rewrites — point `API_URL` env var at
  `https://api.escapesymas.com` (already the default). The browser-facing
  hostname is now resolved by Traefik, not by Docker DNS.
- Admin `nginx.conf` — the in-cluster `proxy_pass http://backend:3001`
  inside nginx works as long as the admin container is attached to the
  `coolify` network and the `backend` alias exists. Optionally tighten it
  to `http://escapes-backend:3001` to match the Coolify service name.

## Migration Checklist

- [ ] Add Traefik labels to `escapes-backend` in Coolify
- [ ] Set alias `backend` on `coolify` for `escapes-backend`
- [ ] Add Traefik labels to the frontend container
- [ ] Add Traefik labels to the admin container
- [ ] Confirm `https://api.escapesymas.com/api/health` returns 200 through
      Traefik
- [ ] Confirm `https://escapesymas.com` serves the frontend through Traefik
- [ ] Confirm `https://admin.escapesymas.com` serves the admin through
      Traefik
- [ ] Remove the corresponding manual entries from
      `/data/coolify/proxy/dynamic/http.yaml` on the VPS

## Notes

- This change is **configuration only**; no code or Dockerfile edits are
  required.
- The manual `/data/coolify/proxy/dynamic/http.yaml` file is still owned by
  Coolify for anything outside label-based routing (e.g. global middlewares).
- If a service must be reachable by an additional name (e.g.
  `escapes-backend` AND `backend`), register both as network aliases on the
  `coolify` network.
