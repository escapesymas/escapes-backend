/**
 * Reembolsos: solicitudes del cliente (refund_requests) y cálculo del importe.
 *
 * El cliente pide el reembolso del pedido completo o de algunas líneas desde
 * "Mi cuenta" explicando el motivo; el equipo lo aprueba (se reembolsa por
 * Stripe) o lo rechaza desde el admin. Todos los importes van en céntimos.
 */
import { pool } from '../db.js';

export const REFUND_REASONS: Record<string, string> = {
  desistimiento: 'Ya no lo quiero (desistimiento)',
  no_compatible: 'No es compatible con mi moto',
  defectuoso: 'Ha llegado defectuoso o dañado',
  equivocado: 'He recibido un producto equivocado',
  no_recibido: 'No me ha llegado',
  otro: 'Otro motivo',
};

/** Estados de pedido pagado en los que se puede pedir un reembolso. */
export const REFUNDABLE_STATUSES = ['paid', 'processing', 'shipped', 'completed', 'delivered', 'partially_refunded'];

export const REFUND_REASON_MIN = 10;
export const REFUND_REASON_MAX = 2000;

export interface RefundLine {
  itemId: number;
  productId: number | null;
  name: string;
  quantity: number;
  /** Precio unitario en céntimos, el de la línea del pedido. */
  priceCents: number;
}

/**
 * Importe a devolver por unas líneas: lo que se pagó realmente por ellas.
 * El total del pedido puede llevar descuentos, envío y, en Canarias, ir sin
 * IVA; se reparte en proporción al peso de las líneas en los productos.
 * El pedido completo devuelve el total (envío incluido) menos lo ya devuelto.
 */
export function refundEstimate(
  order: { total: number; shipping_cost: number | null; refunded_amount: number | null },
  allLines: Array<{ quantity: number; price: number }>,
  selected: Array<{ quantity: number; priceCents: number }>,
  scope: 'full' | 'partial',
): number {
  const total = Math.round(Number(order.total) || 0);
  const already = Math.round(Number(order.refunded_amount) || 0);
  const remaining = Math.max(0, total - already);
  if (scope === 'full') return remaining;
  const productsPaid = Math.max(0, total - Math.round(Number(order.shipping_cost) || 0));
  const allSum = allLines.reduce((acc, l) => acc + (Number(l.price) || 0) * (Number(l.quantity) || 0), 0);
  const selSum = selected.reduce((acc, l) => acc + l.priceCents * l.quantity, 0);
  if (allSum <= 0) return 0;
  return Math.min(remaining, Math.round(selSum * (productsPaid / allSum)));
}

export interface RefundRequestRow {
  id: number;
  order_id: number;
  scope: 'full' | 'partial';
  items: RefundLine[];
  amount_cents: number;
  reason_code: string;
  reason: string;
  status: 'pending' | 'refunded' | 'rejected';
  admin_note: string | null;
  refunded_cents: number;
  created_at: string;
  resolved_at: string | null;
}

/** Solicitudes de varios pedidos, agrupadas por pedido (más reciente primero). */
export async function refundRequestsByOrder(orderIds: number[]): Promise<Map<number, RefundRequestRow[]>> {
  const map = new Map<number, RefundRequestRow[]>();
  if (!orderIds.length) return map;
  const r = await pool.query(
    `SELECT id, order_id, scope, items, amount_cents, reason_code, reason, status, admin_note,
            refunded_cents, created_at, resolved_at
       FROM refund_requests WHERE order_id = ANY($1) ORDER BY created_at DESC`, [orderIds]);
  for (const row of r.rows) {
    const list = map.get(row.order_id) || [];
    list.push(row);
    map.set(row.order_id, list);
  }
  return map;
}

/** Forma pública de una solicitud (para el cliente y el admin). */
export function refundRequestView(r: RefundRequestRow) {
  return {
    id: r.id,
    scope: r.scope,
    items: r.items || [],
    amount: r.amount_cents / 100,
    reasonCode: r.reason_code,
    reasonLabel: REFUND_REASONS[r.reason_code] || r.reason_code,
    reason: r.reason,
    status: r.status,
    adminNote: r.admin_note,
    refunded: r.refunded_cents / 100,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}
