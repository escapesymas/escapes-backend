-- Origen de la descripción del producto: 'bihr' si la rellenó lib/bihr-descriptions.ts con el catálogo del
-- proveedor (se puede refrescar o deshacer); NULL si se escribió a mano o venía de antes.
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_source TEXT;
