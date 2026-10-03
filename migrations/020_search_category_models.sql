-- Búsqueda por categoría y por modelo de moto.
--
-- «casco integral» no encontraba cascos (el nombre de la categoría no estaba en
-- el texto de búsqueda) y «kit cadena mt-07» daba 0 resultados (los kits no
-- llevan el modelo en el nombre, aunque sí en la compatibilidad).
--
-- search_extra = nombres de la categoría y sus padres + marcas/modelos
-- compatibles (sin años, como mucho 80). Se incluye en search_text.
-- El recálculo masivo lo hace lib/catalog-backfill.ts por lotes (versión 3).

ALTER TABLE products ADD COLUMN IF NOT EXISTS search_extra TEXT;

CREATE OR REPLACE FUNCTION products_search_extra(p_category_id INTEGER, p_compat JSONB)
RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT concat_ws(' ',
    (WITH RECURSIVE up AS (
        SELECT id, name, parent_id, 1 AS depth FROM categories WHERE id = p_category_id
        UNION ALL
        SELECT c.id, c.name, c.parent_id, up.depth + 1 FROM categories c JOIN up ON c.id = up.parent_id
        WHERE up.depth < 6)
     SELECT string_agg(name, ' ') FROM up),
    (SELECT string_agg(m, ' ') FROM (
        SELECT DISTINCT lower(concat_ws(' ', e->>'brand', e->>'model')) AS m
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_compat) = 'array' THEN p_compat ELSE '[]'::jsonb END) e
        WHERE e->>'model' IS NOT NULL
        LIMIT 80) x)
  )
$$;

CREATE OR REPLACE FUNCTION products_search_text(
  p_name TEXT, p_supplier_name TEXT, p_brand TEXT, p_sku TEXT,
  p_part_number TEXT, p_barcode TEXT, p_supplier_code TEXT, p_old_part_number TEXT, p_extra TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH base AS (
    SELECT lower(immutable_unaccent(concat_ws(' ',
      p_name, p_supplier_name, p_brand, p_sku, p_part_number, p_barcode, p_supplier_code, p_old_part_number, p_extra
    ))) AS t
  )
  SELECT t || ' ' || regexp_replace(t, '([a-z0-9])[-./]([a-z0-9])', '\1\2', 'g') FROM base
$$;

CREATE OR REPLACE FUNCTION products_search_text_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.compatibility IS DISTINCT FROM OLD.compatibility OR NEW.search_extra IS NULL THEN
    NEW.search_extra := products_search_extra(NEW.category_id, NEW.compatibility);
  END IF;
  NEW.search_text := products_search_text(
    NEW.name, NEW.supplier_name, NEW.brand, NEW.sku,
    NEW.part_number, NEW.barcode, NEW.supplier_code, NEW.old_part_number, NEW.search_extra
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
  BEFORE INSERT OR UPDATE OF name, supplier_name, brand, sku, part_number, barcode, supplier_code,
    old_part_number, category_id, compatibility
  ON products FOR EACH ROW EXECUTE FUNCTION products_search_text_trg();
