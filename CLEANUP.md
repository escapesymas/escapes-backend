# Cleanup v2-cart-fix legacy backend

The backend was originally deployed as a manual `docker build` + `docker run`
(image `localhost:5000/escapes-backend:v2-cart-fix`). Coolify now deploys a
fresh image (`wg90ssxowlynpipdyxil35lw:...`) on every push, so the legacy
container and image can be retired once service discovery has been validated.

> **DO NOT** run the cleanup steps below until the pre-flight checks all pass
> and Traefik is confirmed to be pointing at the new `backend` hostname (not
> the old container). See the IMPORTANT note at the bottom of this document.

## Pre-flight checks

Confirm the new Coolify-deployed stack is healthy and serving traffic before
touching the legacy container.

1. Confirm the new container is up and healthy:

   ```bash
   docker ps | grep wg90ssxowlynpipdyxil35lw
   ```

   Expect a row with status `Up ... (healthy)`.

2. Confirm the health endpoint responds 200:

   ```bash
   curl -fsS -o /dev/null -w "%{http_code}\n" http://api.escapesymas.com/api/health
   ```

   Expect `200`.

3. Confirm the frontend still serves content via the API:

   ```bash
   curl -fsS http://www.escapesymas.com/universales | head
   ```

   Expect non-empty HTML.

If any of these fail, **stop** and do not proceed with the cleanup.

## Steps

Run these on the VPS (root@212.227.134.161):

```bash
# 1. Stop the old container
docker stop wg90ssxowlynpipdyxil35lw-171018418092
# 2. Remove it
docker rm wg90ssxowlynpipdyxil35lw-171018418092
# 3. Remove the old image
docker rmi localhost:5000/escapes-backend:v2-cart-fix
# 4. Verify
docker ps --format "{{.Names}}\t{{.Image}}" | grep -E "backend"
```

After step 4 the only `backend` line should reference the new Coolify image
(`wg90ssxowlynpipdyxil35lw:...`), not `localhost:5000/escapes-backend:v2-cart-fix`.

## Rollback

If anything breaks after the cleanup:

- The old container is gone, but the `v2-cart-fix` tag was pushed to the local
  registry (`localhost:5000/escapes-backend`), so you can rebuild from that tag
  if it was previously pushed to a registry you can pull from.
- Alternatively, redeploy via Coolify — it builds and runs the current
  `main` branch on every push, so a `git push` will resurrect the service
  within a couple of minutes.

## IMPORTANT

Do NOT run this until confirming service discovery is in place (Traefik
pointing at the `backend` hostname, not the old container). The legacy
container has been the implicit backend target; once it is removed, any
Traefik rule still pinned to its container name will break the API.

Verify in the Traefik dashboard / labels that the `backend` router points at
the new Coolify service (`wg90ssxowlynpipdyxil35lw-...`) before executing
the steps above.
