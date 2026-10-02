import pkg from 'pg';
const { Pool } = pkg;
import { drizzle } from 'drizzle-orm/node-postgres';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  // Conexiones ociosas que la red corta: keepalive y reciclado antes de que caduquen.
  keepAlive: true,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Un cliente ocioso que pierde la conexión (p. ej. read ETIMEDOUT) emite 'error'
// en el pool; sin este manejador Node lo trata como excepción y tumba la API.
pool.on('error', (err) => {
  console.error('[DB] Error en una conexión ociosa del pool:', err.message);
});

export const db = drizzle(pool);

export default db;
