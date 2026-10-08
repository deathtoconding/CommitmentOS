import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    'Database check failed: set DATABASE_URL (for local development, copy .env.example to .env).',
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  application_name: 'commitmentos-db-check',
});

try {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      EXISTS (
        SELECT 1
        FROM information_schema.schemata
        WHERE schema_name = 'commitmentos'
      ) AS app_schema_exists
  `);
  const { database_name: databaseName, app_schema_exists: appSchemaExists } = result.rows[0];

  if (!appSchemaExists) {
    console.error(
      'Database check failed: the commitmentos schema is missing; run npm run db:migrate.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `PostgreSQL is ready; connected to database "${databaseName}" with the commitmentos schema.`,
    );
  }
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
  console.error(
    `Database check failed (${code}). Verify DATABASE_URL and that PostgreSQL is reachable.`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
