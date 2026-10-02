-- Búsqueda: referencias compactas y vocabulario para corregir erratas.
--
-- 1) search_text incluye también la versión "compacta" de referencias con
--    guiones/puntos/barras ("10w-40" → "10w40", "rk-520" → "rk520"), para que
--    las búsquedas encuentren ambas formas.
-- 2) catalog_words: palabras distintas de los nombres publicados con su
--    frecuencia. Con un índice trigram permite corregir "pastilas" → "pastillas".
--    Se refresca tras el enriquecimiento del catálogo (lib/catalog-enrich.ts).

CREATE OR REPLACE FUNCTION products_search_text(
  p_name TEXT, p_supplier_name TEXT, p_brand TEXT, p_sku TEXT,
  p_part_number TEXT, p_barcode TEXT, p_supplier_code TEXT, p_old_part_number TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH base AS (
    SELECT lower(immutable_unaccent(concat_ws(' ',
      p_name, p_supplier_name, p_brand, p_sku, p_part_number, p_barcode, p_supplier_code, p_old_part_number
    ))) AS t
  )
  SELECT t || ' ' || regexp_replace(t, '([a-z0-9])[-./]([a-z0-9])', '\1\2', 'g') FROM base
$$;

-- El recálculo de search_text NO se hace aquí (sería un UPDATE masivo dentro
-- de una transacción que bloquearía el stock durante minutos): lo hace
-- lib/catalog-backfill.ts por lotes cortos al detectar la nueva versión.
CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE MATERIALIZED VIEW IF NOT EXISTS catalog_words AS
SELECT w AS word, count(*)::int AS freq
FROM products p,
     regexp_split_to_table(lower(immutable_unaccent(coalesce(p.name, '') || ' ' || coalesce(p.brand, ''))), '[^a-z0-9]+') AS w
WHERE p.status = 'published' AND length(w) >= 3 AND w !~ '^[0-9]+$'
GROUP BY w;

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_words_word ON catalog_words (word);
CREATE INDEX IF NOT EXISTS idx_catalog_words_trgm ON catalog_words USING gin (word gin_trgm_ops);
