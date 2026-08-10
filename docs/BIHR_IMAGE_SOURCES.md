# Bihr image sources — research notes (2026-08-10)

The Bihr image URLs in `api.mybihr.com/medias/{sku}-1-800Wx800H?context=...`
no longer return 200 from any source tested (workstation, production server,
with or without Bearer auth). Confirmed by `/api/admin/trace-image`:

- `api.mybihr.com/medias/...`: 404, `application/octet-stream`
- `api.bihr.net/api/v2.1/Products/Image/{sku}`: 404
- `api.bihr.net/api/v2.1/Products/Image/{supplier_code}`: 404

The **working strategy** is the per-brand `AllPicturesZIP` static URL:

```
https://static.bihr.pro/eBihr/Pictures/{BRAND}-pictures.zip
```

Each brand's zip is ~1 GB and contains every SKU image for that brand, named
`<sku>-1.jpg`, `<sku>-2.jpg`, etc. Files inside are deflate-compressed.

## How to fetch one image without downloading 1 GB

1. Parse the central directory of the zip via HTTP Range:
   ```
   GET /eBihr/Pictures/{BRAND}-pictures.zip
   Range: bytes={cd_offset}-{cd_end}
   ```
   The CD offset/size are in the end-of-central-directory record (last ~64 KB
   of the zip, also fetchable via `Range: bytes=-65536`). 370 KB for ~6000 entries.

2. Find the entry whose filename starts with `<sku>-`; record `local_offset` and
   `compressed_size`.

3. Fetch the local file header + compressed data via Range:
   ```
   Range: bytes={local_offset-50}-{local_offset-50 + 30 + name_len + extra_len + compressed_size}
   ```
   (50 bytes of slack handles the local file header + filename + extra field).

4. Parse the LFH to get `comp_size`, then decompress with `zlib.decompress(buf, -15)`
   (raw deflate — no zlib header).

Verified end-to-end: downloaded `8003149001-1.jpg` (29 KB JPEG, 800x600) for
product id=107 using these steps from the workstation.

## Catalog → brand mapping

The catalog CSV filename tells us the brand:
```
cat-extended-full-ES01-ES001-es-2026_08_09_00_15_02_<BRAND>.csv
```
where `<BRAND>` becomes `https://static.bihr.pro/eBihr/Pictures/<BRAND>-pictures.zip`.

Edge cases to handle:
- brand names with spaces (e.g. `FLY RACING`, `TROY LEE DESIGNS`) — URL-encode the
  space as `%20`.
- SKUs that aren't in the brand's zip (e.g. if Bihr moved them) — log and skip.