-- Modelos de moto distintos presentes en products.compatibility.
-- Lo crea también el backend al arrancar (lib/compat.ts, ensureCompatModels)
-- y se refresca tras cada importación de Bihr (refreshCompatModels).
CREATE MATERIALIZED VIEW IF NOT EXISTS compat_vehicle_models AS
SELECT DISTINCT upper(e->>'brand') AS brand, (e->>'year') AS year, e->>'model' AS model
FROM products p
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(p.compatibility) = 'array' THEN p.compatibility ELSE '[]'::jsonb END
) e
WHERE p.status = 'published' AND e->>'brand' IS NOT NULL AND e->>'model' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cvm_brand_year ON compat_vehicle_models (brand, year);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cvm_unique ON compat_vehicle_models (brand, year, model);
