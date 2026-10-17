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
## TLS de static.bihr.pro (2026-10-17)

Desde el contenedor del backend, `static.bihr.pro` falla con `UNABLE_TO_VERIFY_LEAF_SIGNATURE`:
el servidor no manda el certificado intermedio y Node (a diferencia de los navegadores) no lo
busca. `lib/range-http.ts` hace lo que hace un navegador: ante ese error lee la dirección
«CA Issuers» del certificado, descarga el intermedio y reintenta verificando la cadena entera
contra las raíces de Mozilla. No se desactiva ninguna comprobación. Lo usa «Descargar fotos de
Bihr» (`lib/bihr-images.ts`); `scripts/download-images-from-zip.ts` sigue usando `fetch`.

## Fotos por producto: API v3 `Products/Details` (2026-10-17)

`POST https://api.bihr.net/api/v3/Products/Details` con `{"productCriteria":[{"partNumber":"1008266"}],"language":"es"}`
(Bearer; se usa el token de la v2.1, por confirmar en producción) devuelve por producto `pictures: [{isDefault, url}]`: todas sus fotos, cada una con
su enlace actual (`https://api.mybihr.com/medias/800Wx800H-{código}-{n}.jpg?context=…`). Acepta varios números de pieza
en una sola llamada. Es la fuente de la descarga en bloque (`bihrProductPictures` en `lib/bihr-images.ts`, de 20 en 20) y la
primera que prueba el botón de la ficha.

El `context` firmado lleva la ruta del fichero: **cambiar solo la referencia del enlace sirve la foto del producto
original** (probado con 1008253 → 1008245: la misma foto, 45.150 bytes), así que no se pueden construir enlaces. Los
enlaces de los CSV antiguos caducan (404); el catálogo JSON (`DefaultPicture`, `lib/bihr-catalog-pictures.ts`) trae el actual.
Solo se aceptan enlaces cuyo fichero lleve el código del producto.

El zip de una marca puede pasar de 4 GB (RST): no se lee por rangos (ZIP64) y la descarga en bloque ya no lo usa.
