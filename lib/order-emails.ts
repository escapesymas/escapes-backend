import { pool } from '../db.js';
import type { EmailItem } from './email-templates.js';

/** Líneas de un pedido para los correos (nombre, imagen y enlace del producto). */
export async function orderEmailItems(orderId: number): Promise<EmailItem[]> {
  const r = await pool.query(
    `SELECT oi.quantity, oi.price, p.name, p.sku, p.id AS pid, p.images->0->>'src' AS image
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id`, [orderId]);
  return r.rows.map((x: any) => ({
    name: x.name || 'Producto',
    quantity: Number(x.quantity) || 1,
    priceCents: Math.round(Number(x.price) || 0),
    image: x.image || '',
    url: x.sku || x.pid ? `/producto/${encodeURIComponent(x.sku || x.pid)}` : '',
  }));
}
