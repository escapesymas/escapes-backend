# Deployment Guide

This document covers the deployment of the `escapes-backend` service on Coolify.

## Persistent Storage

The container writes two kinds of files to `/app/server/uploads/`:

1. **User-uploaded files** — images submitted by end users (e.g. avatars, custom uploads) via the `multer` upload endpoint in `index.ts`.
2. **Downloaded product images** — optimization scripts (e.g. `scripts/download_missing_sizes.ts`, `scripts/download_images_andreani.ts`, `scripts/download_images_local.ts`) fetch product images from Bihr / Andreani and write the resized/optimized variants to `/app/server/uploads/optimized/`.

The Dockerfile creates the directory at build time:

```dockerfile
RUN mkdir -p /app/server/uploads /app/server/invoices && chown backend:nodejs /app/server/uploads /app/server/invoices
```

But the container's filesystem is **ephemeral**. Every time Coolify redeploys (new image push, restart, or scale-down), the container is replaced and **all files under `/app/server/uploads/` are lost**. That means:

- User-uploaded images disappear.
- The Bihr/Andreani optimized cache under `/app/server/uploads/optimized/` is wiped, forcing the next request to re-download and re-resize every image — slow and wasteful.

### Configuring the volume in Coolify

To make the data survive redeploys, mount a persistent volume at `/app/server/uploads`:

1. Open **Coolify** → select the `escapes-backend` application.
2. Go to **Configuration** → **Persistent Storage**.
3. Click **Add a new volume** with these values:

   | Field | Value |
   |-------|-------|
   | Source path on host | `/coolify-data/escapes-uploads` (or any path under the Coolify data directory) |
   | Destination path in container | `/app/server/uploads` |
   | Type | `volume` |

4. Save and redeploy.

> **Note on the `optimized/` subdirectory:** because the scripts write to `/app/server/uploads/optimized/`, the parent mount at `/app/server/uploads` automatically covers it. You do **not** need a separate volume for the subdirectory.

### Verify the mount is in place

After redeploy, exec into the container and confirm the volume is mounted and writable:

```bash
docker exec <container> ls -la /app/server/uploads/
```

You should see the `optimized/` subdirectory (and any files previously downloaded). To verify the mount point itself:

```bash
docker exec <container> mount | grep uploads
```

If the volume is configured correctly, the output will show `/app/server/uploads` backed by a host bind mount instead of the container's overlay filesystem.

### Backup recommendation

The volume on the host is the source of truth. Snapshot `/coolify-data/escapes-uploads` (or whatever path you picked) on your normal backup schedule, since the database does **not** store the image binaries themselves.
