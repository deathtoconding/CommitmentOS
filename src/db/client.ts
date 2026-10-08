import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getDatabaseUrl } from './config';

export function createDatabase(connectionString?: string) {
  const pool = new Pool({
    connectionString: getDatabaseUrl(connectionString),
    application_name: 'commitmentos',
  });

  return {
    database: drizzle(pool),
    pool,
  };
}
