import 'server-only';
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

type DatabaseClient = ReturnType<typeof createDatabase>;

const globalDatabase = globalThis as typeof globalThis & {
  commitmentosDatabase?: DatabaseClient;
};

const databaseClient = globalDatabase.commitmentosDatabase ?? createDatabase();
if (process.env.NODE_ENV !== 'production') {
  globalDatabase.commitmentosDatabase = databaseClient;
}

export const database = databaseClient.database;
export const databasePool = databaseClient.pool;
