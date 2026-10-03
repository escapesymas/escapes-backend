-- Traducciones de nombres de producto que Bihr manda en inglés o a medias
-- («RENTHAL Road Low 754 Handlebar»). Las rellena lib/name-translation.ts y
-- lib/catalog-enrich.ts las vuelve a aplicar tras cada sincronización.
CREATE TABLE IF NOT EXISTS name_translations (
  source_name TEXT PRIMARY KEY,
  name_es     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
