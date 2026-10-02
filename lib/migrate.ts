/**
 * Migraciones SQL versionadas.
 *
 * Aplica, en orden y una sola vez, los ficheros `migrations/NNN_nombre.sql`
 * con número >= FIRST_TRACKED. Cada fichero se ejecuta en su propia
 * transacción y queda registrado en `schema_migrations`.
 *
 * Las migraciones anteriores (000-007) son idempotentes y ya están aplicadas
 * en producción; no se registran aquí para no cambiar su comportamiento.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';

const FIRST_TRACKED = 8;

function migrationsDir(): string {
  // Funciona tanto con tsx (lib/) como compilado (dist/lib/).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../migrations'),
    path.resolve(here, '../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
  ];
  // dist/migrations existe (tsc compila ahí los .ts antiguos) pero no tiene los
  // .sql: hay que elegir la carpeta que realmente los contiene.
  const hasSql = (d: string) => fs.existsSync(d) && fs.readdirSync(d).some((f) => /^\d{3}_.+\.sql$/.test(f));
  return candidates.find(hasSql) || candidates[0];
}

export async function runMigrations(): Promise<string[]> {
  const dir = migrationsDir();
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f) && parseInt(f.slice(0, 3), 10) >= FIRST_TRACKED)
    .sort();

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Evita que dos réplicas apliquen la misma migración a la vez.
    await client.query('SELECT pg_advisory_lock(727001)');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r: any) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sqlText = fs.readFileSync(path.join(dir, file), 'utf-8');
      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        console.log(`[MIGRATE] ${file} aplicada en ${Date.now() - started} ms`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[MIGRATE] Error en ${file}:`, err);
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}
