-- Búsqueda por subcategoría.
--
-- search_extra solo llevaba la categoría principal («Cascos»): «casco integral»
-- encontraba 61 de los 1.361 cascos integrales (los que lo dicen en el nombre) y
-- «casco integral talla m» ninguno. Ahora se parte de la categoría más concreta
-- (category3 → category2 → category) y se suben todos sus padres.
-- El recálculo masivo lo hace lib/catalog-backfill.ts (versión 4).

CREATE OR REPLACE FUNCTION products_search_text_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.category2_id IS DISTINCT FROM OLD.category2_id
     OR NEW.category3_id IS DISTINCT FROM OLD.category3_id
     OR NEW.compatibility IS DISTINCT FROM OLD.compatibility OR NEW.search_extra IS NULL THEN
    NEW.search_extra := products_search_extra(
      COALESCE(NEW.category3_id, NEW.category2_id, NEW.category_id), NEW.compatibility);
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
    old_part_number, category_id, category2_id, category3_id, compatibility
  ON products FOR EACH ROW EXECUTE FUNCTION products_search_text_trg();
