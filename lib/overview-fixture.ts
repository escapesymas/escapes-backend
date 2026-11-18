/** Informe de ejemplo para las pruebas del PDF y de la IA (no se usa en producción). */
import { resolvePeriod } from './overview-period.js';
import { buildKpis, type OverviewData, type OverviewReport } from './overview-report.js';

const sales = (o: Partial<OverviewData['salesCur']> = {}): OverviewData['salesCur'] => ({
  orders: 4, revenueCents: 48_000, shippingCents: 1_999, discountCents: 2_000, taxCents: 8_331, buyers: 3, couponOrders: 1,
  pendingOrders: 1, pendingCents: 9_900, cancelled: 0, refundedOrders: 0, refundedCents: 0, units: 7, costCents: 21_000, ...o,
});
const people = (o: Partial<OverviewData['peopleCur']> = {}): OverviewData['peopleCur'] => ({
  newCustomers: 5, aiChats: 30, aiAnonymous: 12, aiHandoffs: 3, aiTurns: 90, advisorChats: 3, advisorWaitMin: 4.5, chatOrders: 1, chatOrdersPaid: 1,
  reviews: 2, reviewsAvg: 4.5, refundRequests: 0, ...o,
});
const visits = (o: Partial<NonNullable<OverviewData['visitsCur']>> = {}): NonNullable<OverviewData['visitsCur']> => ({
  visitors: 1200, pageviews: 3300, bounces: 700, mobile: 880, productViews: 400, addToCart: 40, checkout: 12, purchase: 4, chat: 9, signUps: 3,
  searchSessions: 60, noResultSessions: 8, notFoundEvents: 6, addToCartEvents: 55, cartValue: 4_300.5, ...o,
});

export function makeData(over: Partial<OverviewData> = {}): OverviewData {
  return {
    salesCur: sales(), salesPrev: sales({ orders: 2, revenueCents: 20_000, taxCents: 3_471, units: 3, costCents: 9_000, buyers: 2, couponOrders: 0 }),
    peopleCur: people(), peoplePrev: people({ newCustomers: 2, aiChats: 10 }),
    abandonCur: { detected: 6, valueCents: 90_000, emailed: 4, recovered: 2, recoveredCents: 30_000 },
    abandonPrev: { detected: 3, valueCents: 40_000, emailed: 3, recovered: 1, recoveredCents: 10_000 },
    visitsCur: visits(), visitsPrev: visits({ visitors: 800, pageviews: 1900, bounces: 560, addToCart: 20, checkout: 5, cartValue: 1_800 }),
    googleCur: 700, googlePrev: 400, customersTotal: 80,
    products: { published: 100_000, inStock: 70_000 },
    cartsNow: { active: { count: 5, value: 640.25, guests: 4, stale: 3 }, top: [] },
    ...over,
  };
}

export function makeReport(over: { visits?: boolean; yoyNoData?: boolean } = {}): OverviewReport {
  const period = resolvePeriod({ preset: '7d', compare: over.yoyNoData ? 'yoy' : 'prev' }, new Date('2026-11-18T11:00:00Z'));
  const data = makeData({
    ...(over.visits === false ? { visitsCur: null, visitsPrev: null, googleCur: null, googlePrev: null } : {}),
    ...(over.yoyNoData ? { prevAvail: { store: false, visits: false } } : {}),
  });
  const days = ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'];
  return {
    period, generatedAt: '2026-11-18T21:30:00.000Z', excludeInternal: true,
    headline: ['sales_revenue', 'sales_orders', 'sales_avg', 'visitors', 'conv_rate', 'carts_added', 'carts_active_value', 'customers_new'],
    kpis: buildKpis(data),
    sales: {
      byDay: days.map((date, i) => ({ date, orders: i % 3, revenue: (i % 3) * 120.5 })),
      topProducts: [{ name: 'Escape completo TECNIGAS E-Box 2', sku: '1123423', units: 2, revenue: 538 }, { name: 'Pastillas de freno delanteras', sku: 'P-1', units: 5, revenue: 120.5 }],
      payments: [{ method: 'card', orders: 3, revenue: 430 }, { method: 'paypal', orders: 1, revenue: 50 }],
      coupons: [{ code: 'BIENVENIDA', orders: 1, discount: 20 }],
    },
    visits: over.visits === false ? null : {
      byDay: days.map((date, i) => ({ date, visitors: 100 + i * 12, pageviews: 300 + i * 30, carts: i, checkouts: i % 2, cartValue: i * 45 })),
      topPages: [{ path: '/', title: 'Escapes y Más — Inicio', views: 240, visitors: 130 }, { path: '/producto/1123423', title: 'Escape TECNIGAS E-Box 2 → ficha', views: 90, visitors: 60 }],
      sources: [{ name: 'Google', visitors: 700 }, { name: 'Directo / sin origen', visitors: 250 }, { name: 'TikTok', visitors: 80 }],
      cities: [{ city: 'Madrid', country: 'ES', visitors: 98 }, { city: 'Desconocida', country: 'US', visitors: 50 }],
      devices: [{ device: 'mobile', visitors: 880 }, { device: 'desktop', visitors: 200 }],
      topSearches: [{ term: 'escape honda pcx', count: 7 }],
      noResultSearches: [{ term: 'aceite honda dulan', count: 3 }],
      topBikes: [{ term: 'yamaha mt-09 (2021)', count: 6 }],
    },
    compareSeries: over.yoyNoData
      ? { revenue: days.map(() => null), visitors: days.map(() => null), carts: days.map(() => null) }
      : { revenue: days.map((_, i) => (i === 2 ? null : i * 20)), visitors: days.map((_, i) => 90 + i * 8), carts: days.map((_, i) => i % 3) },
    dataSince: { store: '2026-05-16', visits: '2026-01-01' },
    funnel: over.visits === false ? [] : [
      { key: 'visitors', label: 'Visitantes', current: 1200, previous: over.yoyNoData ? null : 800 },
      { key: 'product', label: 'Ven una ficha', current: 400, previous: over.yoyNoData ? null : 250 },
      { key: 'cart', label: 'Añaden al carrito', current: 40, previous: over.yoyNoData ? null : 20 },
      { key: 'checkout', label: 'Empiezan a pagar', current: 12, previous: over.yoyNoData ? null : 5 },
      { key: 'order', label: 'Pedido pagado', current: 4, previous: over.yoyNoData ? null : 2 },
    ],
    carts: { active: data.cartsNow.active, top: [{ id: 964, email: null, value: 303.05, items: 6, updatedAt: '2026-11-18T13:40:32.101Z' }, { id: 970, email: 'a@b.c', value: 120, items: 2, updatedAt: '2026-11-17T10:00:00.000Z' }] },
    warnings: over.visits === false ? ['Las estadísticas de visitas no están disponibles ahora; el informe sale sin ese apartado.'] : [],
  };
}
