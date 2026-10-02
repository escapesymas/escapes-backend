-- Catálogo: variantes por modelo, duplicados y búsqueda en español.
--
--   part_number      número de pieza de Bihr (NewPartNumber / PartNumber).
--   family_code      agrupa variantes de un mismo modelo. Para Bihr: los 7
--                    primeros dígitos de un número de pieza de 10 dígitos.
--                    Si no hay agrupación, el propio SKU.
--   variant_options  ejes de la variante, p. ej. {"Talla":"XL","Color":"Negro"}.
--   supplier_name    nombre original del proveedor (inglés abreviado), solo
--                    para búsqueda.
--   duplicate_of     id de la ficha canónica cuando esta es un duplicado
--                    (status = 'duplicate'). No se borra nada.
--   search_text      texto normalizado (minúsculas, sin tildes) para buscar.
--
-- Los rellenos masivos (search_text, family_code) los hace el backend en
-- segundo plano por lotes (lib/catalog-backfill.ts) para no bloquear el arranque.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS part_number VARCHAR(40),
  ADD COLUMN IF NOT EXISTS family_code VARCHAR(60),
  ADD COLUMN IF NOT EXISTS variant_options JSONB,
  ADD COLUMN IF NOT EXISTS supplier_name TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of INTEGER,
  ADD COLUMN IF NOT EXISTS search_text TEXT;

-- unaccent() no es IMMUTABLE; este envoltorio permite usarlo en índices.
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

CREATE OR REPLACE FUNCTION products_search_text(
  p_name TEXT, p_supplier_name TEXT, p_brand TEXT, p_sku TEXT,
  p_part_number TEXT, p_barcode TEXT, p_supplier_code TEXT, p_old_part_number TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(immutable_unaccent(concat_ws(' ',
    p_name, p_supplier_name, p_brand, p_sku, p_part_number, p_barcode, p_supplier_code, p_old_part_number
  )))
$$;

CREATE OR REPLACE FUNCTION products_search_text_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := products_search_text(
    NEW.name, NEW.supplier_name, NEW.brand, NEW.sku,
    NEW.part_number, NEW.barcode, NEW.supplier_code, NEW.old_part_number
  );
  IF NEW.family_code IS NULL THEN
    NEW.family_code := CASE
      WHEN NEW.part_number ~ '^[0-9]{10}$' THEN left(NEW.part_number, 7)
      WHEN NEW.sku ~ '^[0-9]{10}$' THEN left(NEW.sku, 7)
      ELSE NEW.sku
    END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS products_search_text_biu ON products;
CREATE TRIGGER products_search_text_biu
  BEFORE INSERT OR UPDATE OF name, supplier_name, brand, sku, part_number, barcode, supplier_code, old_part_number
  ON products FOR EACH ROW EXECUTE FUNCTION products_search_text_trg();

CREATE INDEX IF NOT EXISTS idx_products_search_text_trgm ON products USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_family_code ON products (family_code);
CREATE INDEX IF NOT EXISTS idx_products_part_number ON products (part_number);
CREATE INDEX IF NOT EXISTS idx_products_variant_options ON products USING gin (variant_options);
CREATE INDEX IF NOT EXISTS idx_products_status_family ON products (status, family_code);
