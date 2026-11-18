/**
 * Stock en vivo de lo que se va a enseñar o vender, sea de Bihr o de Andreani.
 *
 * Cada proveedor tiene su módulo con sus protecciones (lib/bihr-live-stock.ts, lib/andreani-live-stock.ts); este los
 * junta para quien no necesita distinguirlos: los ids de otro proveedor no se tocan y el resultado trae solo lo que se
 * ha podido saber. No lanza nunca.
 */
import { refreshLiveBihrStock, type LiveStock } from './bihr-live-stock.js';
import { refreshLiveAndreaniStock } from './andreani-live-stock.js';

export type { LiveStock };

export interface LiveStockOptions {
  /** Cuánto vale un dato en caché (segundos). Para el pedido, menos que para los listados. */
  ttlSec?: number;
}

export async function refreshLiveStock(ids: number[], opts: LiveStockOptions = {}): Promise<Map<number, LiveStock>> {
  const [bihr, andreani] = await Promise.all([refreshLiveBihrStock(ids, opts), refreshLiveAndreaniStock(ids, opts)]);
  for (const [id, live] of andreani) bihr.set(id, live);
  return bihr;
}

/** La forma que se manda al navegador: lo mismo que ya llevan las tarjetas (`inStock`, `restocking`...). */
export function liveStockView(live: LiveStock) {
  return {
    stock: live.stock,
    inStock: live.stock > 0,
    restockDate: live.restockDate,
    restocking: live.stock <= 0 && !!live.restockDate,
  };
}
