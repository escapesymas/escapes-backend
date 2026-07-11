import pkg from 'pg';
const { Pool } = pkg;
import { drizzle } from 'drizzle-orm/node-postgres';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

export const db = drizzle(pool);

export default db;
