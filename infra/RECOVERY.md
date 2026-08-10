# Recovery procedure after a backend redeploy

Each Coolify redeploy of `escapes-backend` wipes the container's filesystem.
Two things that aren't (yet) on a persistent volume must be restored by hand:

1. `/app/server/catalog-csv/` — 256 CSV files (210 MB) used by the
   v4 image downloader to map SKU → image URL.
2. The image cache under `/app/server/uploads/optimized/` is already
   covered by the persistent volume mount configured in Coolify (see
   DEPLOY.md), so it survives redeploys.

## Run from your workstation

```bash
# 1. Re-upload the CSVs (takes ~30 s on a fast link)
CONTAINER=$(ssh root@178.156.132.15 \
  "docker ps --format '{{.Names}}' | grep '^wg90ssxowlynpipdyxil35lw' | head -1")
echo "Target container: $CONTAINER"

# Extract locally and pipe into the container (avoids staging on the host)
unzip -p /home/adrian/Descargas/cat-extended-full-ES01-ES001-es-2026_08_09_00_15_02.zip \
  | ssh root@178.156.132.15 \
      "docker exec -i $CONTAINER bash -c 'mkdir -p /app/server/catalog-csv && tar x -C /app/server/catalog-csv'"

# Verify
ssh root@178.156.132.15 "docker exec $CONTAINER ls /app/server/catalog-csv | wc -l"
# Expect: 256

# 2. Make sure the post-deploy hook is installed on the host
ssh root@178.156.132.15 "test -x /usr/local/bin/escapes-post-deploy.sh && echo OK || echo MISSING"
# If MISSING, install from the repo:
scp infra/escapes-post-deploy.sh root@178.156.132.15:/usr/local/bin/escapes-post-deploy.sh
ssh root@178.156.132.15 "chmod +x /usr/local/bin/escapes-post-deploy.sh"

# 3. Make sure the cron job exists (runs every 5 min, keeps the proxy
#    pointing at the right container after each redeploy)
ssh root@178.156.132.15 "crontab -l | grep -q escapes-post-deploy && echo OK || echo MISSING"
# If MISSING, install:
ssh root@178.156.132.15 "cat > /etc/cron.d/escapes-post-deploy << 'EOF'
*/5 * * * * root /usr/local/bin/escapes-post-deploy.sh >/dev/null 2>&1
EOF
chmod 0644 /etc/cron.d/escapes-post-deploy"

# 4. Restart the image downloader
curl -X POST -H "X-Admin-Key: escapes-admin-sync-key-2026-change-me" \
  -H "Content-Type: application/json" \
  -d '{"batch":5000,"concurrency":20,"loopAll":true}' \
  https://api.escapesymas.com/api/bihr/sync-images-v4/start
```

## After it's working again

Make `/app/server/catalog-csv` a persistent volume too so you don't have
to re-upload after each redeploy. In Coolify UI → escapes-backend →
Persistent Storage, add:

| Field | Value |
|-------|-------|
| Source path on host | `/coolify-data/escapes-catalog-csv` |
| Destination path in container | `/app/server/catalog-csv` |
| Type | `volume` |

Then re-upload once more and the CSVs will survive future redeploys.
