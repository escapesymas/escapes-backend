/**
 * Smoke test de seguridad contra un backend en marcha.
 *
 * Comprueba que los endpoints sensibles exigen sesión/rol y que la identidad
 * sale siempre del JWT, nunca de userId/userEmail en el body o la query.
 *
 * Uso (entorno local, con los usuarios de prueba sembrados):
 *   API_BASE=http://localhost:3901 JWT_SECRET=... npx tsx scripts/smoke-security.ts
 *
 * Usuarios esperados en la BD: 900001 (cliente A, con pedido 900101 y una moto
 * en el garaje), 900002 (cliente B), 900003 (admin).
 */
import jwt from 'jsonwebtoken';

const API = (process.env.API_BASE || 'http://localhost:3901').replace(/\/$/, '');
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET requerido para firmar tokens de prueba');

const token = (id: number, email: string, role = 'customer') =>
  jwt.sign({ user_id: id, email, role, username: email }, SECRET, { expiresIn: '10m' });
const A = token(900001, 'a@test.local');
const B = token(900002, 'b@test.local');
const ADMIN = token(900003, 'admin@test.local', 'admin');

let failed = 0;
async function check(name: string, expected: number | number[], path: string, init: RequestInit & { auth?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (init.auth) headers.Authorization = `Bearer ${init.auth}`;
  if (init.body && typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${res.status} ${name}`);
  return res;
}
const json = (b: unknown) => JSON.stringify(b);

async function main() {
  // Bihr: pedidos dropshipping y consultas de stock solo para admin
  await check('bihr/order sin sesión', 401, '/api/bihr/order', { method: 'POST', body: json({ orderId: 1, items: [] }) });
  await check('bihr/order como cliente', 403, '/api/bihr/order', { method: 'POST', body: json({}), auth: A });
  await check('sync-bihr-stock sin sesión', 401, '/api/admin/sync-bihr-stock', { method: 'POST' });

  // Pedidos de otro usuario por email
  await check('my-orders sin sesión', 401, '/api/orders/my-orders?userEmail=a@test.local');
  const mine = await check('my-orders de B ignora userEmail', 200, '/api/orders/my-orders?userEmail=a@test.local', { auth: B });
  const mineBody = await mine.json();
  if (!Array.isArray(mineBody) || mineBody.some((o: any) => o.id === 900101)) { failed++; console.log('FAIL B ve pedidos de A'); }

  // Garaje
  await check('garage sin sesión', 401, '/api/garage?userEmail=a@test.local');
  const g = await check('garage de B ignora userEmail', 200, '/api/garage?userEmail=a@test.local', { auth: B });
  const gBody = await g.json();
  if (!Array.isArray(gBody) || gBody.length !== 0) { failed++; console.log('FAIL B ve el garaje de A'); }

  // Carrito: no se puede leer el de otro ni modificar perfiles
  const cart = await check('GET cart con userId ajeno', 200, '/api/cart?userId=900001&sessionToken=nada', { auth: B });
  const cartBody = await cart.json();
  if (cartBody.userId === 900001) { failed++; console.log('FAIL B lee el carrito de A'); }
  await check('POST cart con userEmail ajeno', 200, '/api/cart', {
    method: 'POST',
    body: json({ sessionToken: 'smoke-' + Date.now(), items: [], userId: 77001, userEmail: 'attacker@evil.test' }),
  });

  // Avatar
  await check('avatar sin sesión', 401, '/api/upload/avatar', { method: 'POST' });

  // Pago y checkout de pedidos ajenos
  await check('create-payment-intent pedido inexistente', 404, '/api/create-payment-intent', {
    method: 'POST', body: json({ orderId: 999999999, amount: 0.5 }), auth: A,
  });
  await check('create-payment-intent pedido de otro', 404, '/api/create-payment-intent', {
    method: 'POST', body: json({ orderId: 900101, amount: 0.5 }), auth: B,
  });
  await check('checkout-session pedido de otro', 404, '/api/checkout-session?orderId=900101', { auth: B });

  // Pedidos: cantidades negativas
  await check('orders/create con cantidad negativa', 400, '/api/orders/create', {
    method: 'POST', body: json({ cart: [{ id: 1, quantity: -1 }], shippingData: { email: 'x@test.local' } }),
  });

  // Estadísticas y diagnóstico solo admin
  await check('stripe-webhook-stats sin sesión', 401, '/api/admin/stripe-webhook-stats');
  await check('email-stats como cliente', 403, '/api/admin/email-stats', { auth: A });
  await check('health/diag sin sesión', 401, '/api/health/diag');
  await check('health/diag como admin', 200, '/api/health/diag', { auth: ADMIN });

  // Foro: no se puede publicar en nombre de otro
  await check('forum create-thread sin sesión', 401, '/api/forum?action=create-thread', {
    method: 'POST', body: json({ title: 't', content: 'c', userId: 900001 }),
  });

  console.log(failed ? `\n${failed} comprobaciones fallidas` : '\nTodo OK');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
