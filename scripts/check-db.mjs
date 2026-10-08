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
    const objectChecks = await pool.query(`
      SELECT expected.kind, expected.name,
        CASE
          WHEN expected.kind IN ('table', 'index') THEN
            to_regclass(format('%I.%I', 'commitmentos', expected.name)) IS NOT NULL
          WHEN expected.kind = 'type' THEN EXISTS (
            SELECT 1
            FROM pg_type AS app_type
            JOIN pg_namespace AS app_schema ON app_schema.oid = app_type.typnamespace
            WHERE app_schema.nspname = 'commitmentos'
              AND app_type.typname = expected.name
          )
          WHEN expected.kind = 'trigger' THEN EXISTS (
            SELECT 1
            FROM pg_trigger AS app_trigger
            JOIN pg_class AS app_table ON app_table.oid = app_trigger.tgrelid
            JOIN pg_namespace AS app_schema ON app_schema.oid = app_table.relnamespace
            WHERE app_schema.nspname = 'commitmentos'
              AND app_trigger.tgname = expected.name
              AND NOT app_trigger.tgisinternal
          )
        END AS present
      FROM (VALUES
        ('table', 'account'),
        ('table', 'session'),
        ('table', 'user'),
        ('table', 'verification'),
        ('table', 'workspace'),
        ('table', 'workspace_member'),
        ('table', 'commitment'),
        ('table', 'commitment_audit_event'),
        ('type', 'workspace_role'),
        ('type', 'commitment_status'),
        ('type', 'commitment_audit_event_type'),
        ('index', 'workspace_member_workspace_user_unique'),
        ('index', 'workspace_member_user_id_idx'),
        ('index', 'commitment_workspace_status_due_at_idx'),
        ('index', 'commitment_workspace_created_at_id_idx'),
        ('index', 'commitment_workspace_owner_user_id_idx'),
        ('index', 'commitment_workspace_source_message_idx'),
        ('index', 'commitment_audit_event_workspace_commitment_occurred_idx'),
        ('index', 'commitment_audit_event_workspace_occurred_idx'),
        ('trigger', 'commitment_audit_event_no_update_or_delete'),
        ('trigger', 'commitment_audit_event_no_truncate')
      ) AS expected(kind, name)
      ORDER BY expected.kind, expected.name
    `);
    const missingObjects = objectChecks.rows
      .filter((object) => !object.present)
      .map((object) => `${object.kind}:${object.name}`);

    if (missingObjects.length > 0) {
      console.error(
        `Database check failed: required schema objects are missing (${missingObjects.join(', ')}). Run npm run db:migrate.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `PostgreSQL is ready; connected to database "${databaseName}" with the commitmentos schema and required tables, types, indexes, and audit triggers.`,
      );
    }
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
