import { db } from '../index.js';

interface Migration {
  id: number;
  name: string;
  executedAt: Date;
}

const migrations: { id: number; name: string; up: string; down?: string }[] = [];

export async function runMigrations() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    const result = await db.execute(sql`SELECT id, name FROM migrations ORDER BY id`);
    const executedMigrations: Migration[] = result.rows as Migration[];
    
    const lastId = executedMigrations.length > 0 
      ? Math.max(...executedMigrations.map(m => m.id)) 
      : 0;

    const pendingMigrations = migrations.filter(m => m.id > lastId);

    if (pendingMigrations.length === 0) {
      console.log('[MIGRATIONS] No pending migrations');
      return;
    }

    console.log(`[MIGRATIONS] Running ${pendingMigrations.length} pending migrations`);

    for (const migration of pendingMigrations) {
      console.log(`[MIGRATIONS] Running: ${migration.name}`);
      
      try {
        await db.execute(sql.raw(migration.up));
        await db.execute(sql`
          INSERT INTO migrations (id, name) VALUES (${migration.id}, ${migration.name})
        `);
        console.log(`[MIGRATIONS] Completed: ${migration.name}`);
      } catch (error) {
        console.error(`[MIGRATIONS] Failed: ${migration.name}`, error);
        throw error;
      }
    }

    console.log('[MIGRATIONS] All pending migrations completed');
  } catch (error) {
    console.error('[MIGRATIONS] Error running migrations:', error);
    throw error;
  }
}

export async function rollbackMigration(migrationId: number) {
  const migration = migrations.find(m => m.id === migrationId);
  
  if (!migration) {
    throw new Error(`Migration ${migrationId} not found`);
  }
  
  if (!migration.down) {
    throw new Error(`Migration ${migrationId} does not support rollback`);
  }

  console.log(`[MIGRATIONS] Rolling back: ${migration.name}`);
  
  await db.execute(sql.raw(migration.down));
  await db.execute(sql`DELETE FROM migrations WHERE id = ${migrationId}`);
  
  console.log(`[MIGRATIONS] Rollback completed: ${migration.name}`);
}

export { migrations };