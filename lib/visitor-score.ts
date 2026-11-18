/**
 * Prioridad de los visitantes en las estadísticas del panel.
 *
 * Umami guarda cada página y cada evento de un visitante; aquí se resume en una puntuación y un nivel para que el
 * panel enseñe primero a quien más interesa: quien ha puesto algo en el carrito o ha empezado a pagar, y después quien
 * ha visto varias páginas, fichas de producto o ha vuelto a entrar. Sin dependencias (ni base de datos) para poder
 * probarlo.
 */

/** Lo que se sabe de un visitante: contadores de páginas y de los eventos que importan. */
export interface VisitorSignals {
  pageviews: number;
  /** Fichas de producto vistas (evento view_product_detail). */
  productViews: number;
  /** Visitas distintas (Umami abre una visita nueva tras 30 min de inactividad). */
  visits: number;
  addToCart: number;
  /** Inicio de pago (checkout_start / checkout_payment). */
  checkout: number;
  purchase: number;
  chat: number;
  signUp: number;
  searches: number;
  /** Búsquedas sin resultados: demanda que no cubrimos. */
  noResults: number;
  /** Veces que eligió su moto. */
  bikes: number;
}

/** hot: intención de compra · engaged: interés claro · browsing: mira un poco · bounce: una sola página. */
export type VisitorTier = 'hot' | 'engaged' | 'browsing' | 'bounce';

export const TIER_RANK: Record<VisitorTier, number> = { hot: 0, engaged: 1, browsing: 2, bounce: 3 };

export const emptySignals = (): VisitorSignals => ({
  pageviews: 0, productViews: 0, visits: 0, addToCart: 0, checkout: 0, purchase: 0,
  chat: 0, signUp: 0, searches: 0, noResults: 0, bikes: 0,
});

const n = (v: unknown): number => Math.max(0, Number(v) || 0);

/** Convierte las columnas de una fila SQL (cadenas de COUNT) en señales numéricas. */
export function signalsFromRow(r: Record<string, unknown>): VisitorSignals {
  return {
    pageviews: n(r.pageviews),
    productViews: n(r.product_views),
    visits: n(r.visits),
    addToCart: n(r.add_to_cart),
    checkout: n(r.checkout),
    purchase: n(r.purchase),
    chat: n(r.chat),
    signUp: n(r.sign_up),
    searches: n(r.searches),
    noResults: n(r.no_results),
    bikes: n(r.bikes),
  };
}

export function visitorTier(s: VisitorSignals): VisitorTier {
  if (s.purchase > 0 || s.checkout > 0 || s.addToCart > 0 || s.chat > 0 || s.signUp > 0) return 'hot';
  if (s.pageviews >= 4 || s.productViews >= 2 || s.visits >= 2 || s.searches > 0 || s.bikes > 0) return 'engaged';
  if (s.pageviews >= 2) return 'browsing';
  return 'bounce';
}

/**
 * Puntuación para ordenar dentro de un mismo nivel. Los eventos de compra pesan mucho; páginas, fichas y visitas
 * repetidas suman con tope para que un robot que recorre 300 páginas no tape a un cliente de verdad.
 */
export function visitorScore(s: VisitorSignals): number {
  let score = 0;
  if (s.purchase > 0) score += 100;
  if (s.checkout > 0) score += 40;
  if (s.addToCart > 0) score += 25 + 5 * (Math.min(s.addToCart, 5) - 1);
  if (s.chat > 0) score += 15;
  if (s.signUp > 0) score += 15;
  score += 3 * Math.min(s.searches, 5);
  score += 3 * Math.min(s.bikes, 3);
  score += 2 * Math.min(s.noResults, 3);
  score += 2 * Math.min(s.productViews, 10);
  score += Math.min(s.pageviews, 25);
  score += 5 * Math.min(Math.max(s.visits - 1, 0), 5);
  return score;
}

/** Orden de prioridad: nivel, después puntuación y, a igualdad, el visto más recientemente. */
export function compareVisitors(
  a: { tier: VisitorTier; score: number; lastSeenMs: number },
  b: { tier: VisitorTier; score: number; lastSeenMs: number },
): number {
  return TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score || b.lastSeenMs - a.lastSeenMs;
}
