-- Impuestos por destino (país + prefijo de código postal).
--
-- Los precios del catálogo llevan el IVA español (21 %) incluido. Para cada
-- pedido se busca la regla más específica (país + prefijo más largo; si no,
-- la del país) y el importe se recalcula con su tipo:
--   importe destino = importe con IVA / 1,21 × (1 + tipo / 100)
--
-- Canarias, Ceuta y Melilla no llevan IVA (art. 21 LIVA: exportación); el
-- IGIC / IPSI y el despacho los paga el destinatario.
-- Resto de la UE: IVA español mientras las ventas a distancia a la UE no pasen
-- de 10.000 €/año. Superado ese umbral (régimen OSS) se cambia el tipo de cada
-- país en esta tabla, sin tocar código.
CREATE TABLE IF NOT EXISTS tax_rules (
  id SERIAL PRIMARY KEY,
  country CHAR(2) NOT NULL,
  postcode_prefix TEXT NOT NULL DEFAULT '',
  rate NUMERIC(5,2) NOT NULL,
  label TEXT NOT NULL,
  invoice_note TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (country, postcode_prefix)
);

INSERT INTO tax_rules (country, postcode_prefix, rate, label, invoice_note) VALUES
  ('ES', '',   21, 'IVA 21%', NULL),
  ('ES', '35', 0,  'Exento de IVA (Canarias)', 'Operación exenta de IVA (art. 21 LIVA, entrega con destino a Canarias). El IGIC y los gastos de despacho de importación corren a cargo del destinatario.'),
  ('ES', '38', 0,  'Exento de IVA (Canarias)', 'Operación exenta de IVA (art. 21 LIVA, entrega con destino a Canarias). El IGIC y los gastos de despacho de importación corren a cargo del destinatario.'),
  ('ES', '51', 0,  'Exento de IVA (Ceuta)', 'Operación exenta de IVA (art. 21 LIVA, entrega con destino a Ceuta). El IPSI y los gastos de despacho corren a cargo del destinatario.'),
  ('ES', '52', 0,  'Exento de IVA (Melilla)', 'Operación exenta de IVA (art. 21 LIVA, entrega con destino a Melilla). El IPSI y los gastos de despacho corren a cargo del destinatario.'),
  ('PT', '',   21, 'IVA 21%', NULL),
  ('FR', '',   21, 'IVA 21%', NULL),
  ('IT', '',   21, 'IVA 21%', NULL),
  ('DE', '',   21, 'IVA 21%', NULL),
  ('NL', '',   21, 'IVA 21%', NULL),
  ('BE', '',   21, 'IVA 21%', NULL)
ON CONFLICT (country, postcode_prefix) DO NOTHING;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_label TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_note TEXT;
