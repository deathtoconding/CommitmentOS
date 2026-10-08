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
          WHEN expected.kind = 'column' THEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'commitmentos'
              AND table_name = split_part(expected.name, '.', 1)
              AND column_name = split_part(expected.name, '.', 2)
          )
          WHEN expected.kind = 'constraint' THEN EXISTS (
            SELECT 1
            FROM pg_constraint AS app_constraint
            JOIN pg_class AS app_table ON app_table.oid = app_constraint.conrelid
            JOIN pg_namespace AS app_schema ON app_schema.oid = app_table.relnamespace
            WHERE app_schema.nspname = 'commitmentos'
              AND app_constraint.conname = expected.name
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
        ('table', 'rate_limit'),
        ('table', 'email_verification_token_use'),
        ('column', 'rate_limit.key'),
        ('column', 'rate_limit.count'),
        ('column', 'rate_limit.last_request'),
        ('column', 'email_verification_token_use.token_hash'),
        ('column', 'email_verification_token_use.expires_at'),
        ('constraint', 'email_verification_token_use_hash_format'),
        ('constraint', 'rate_limit_count_nonnegative'),
        ('constraint', 'rate_limit_last_request_nonnegative'),
        ('index', 'rate_limit_key_unique'),
        ('index', 'email_verification_token_use_expires_at_idx'),
        ('table', 'workspace'),
        ('table', 'workspace_member'),
        ('table', 'workspace_audit_event'),
        ('table', 'commitment'),
        ('table', 'source_message'),
        ('table', 'commitment_audit_event'),
        ('column', 'commitment.source_message_record_id'),
        ('column', 'source_message.provider'),
        ('column', 'source_message.provider_account_id'),
        ('column', 'source_message.provider_message_id'),
        ('column', 'source_message.provider_timestamp'),
        ('column', 'source_message.legacy_reference'),
        ('table', 'async_job'),
        ('table', 'background_worker_heartbeat'),
        ('column', 'async_job.lease_expires_at'),
        ('column', 'async_job.idempotency_key'),
        ('column', 'async_job.correlation_id'),
        ('column', 'async_job.payload'),
        ('column', 'async_job.failure_class'),
        ('column', 'background_worker_heartbeat.last_heartbeat_at'),
        ('type', 'async_job_status'),
        ('type', 'async_job_failure_class'),
        ('type', 'background_worker_status'),
        ('type', 'workspace_role'),
        ('type', 'workspace_audit_event_type'),
        ('type', 'commitment_status'),
        ('type', 'source_provider'),
        ('type', 'commitment_audit_event_type'),
        ('index', 'workspace_member_workspace_user_unique'),
        ('index', 'workspace_member_user_id_idx'),
        ('index', 'workspace_audit_event_workspace_occurred_idx'),
        ('index', 'workspace_audit_event_target_occurred_idx'),
        ('index', 'commitment_workspace_status_due_at_idx'),
        ('index', 'commitment_workspace_created_at_id_idx'),
        ('index', 'commitment_workspace_owner_user_id_idx'),
        ('index', 'commitment_workspace_source_message_idx'),
        ('index', 'commitment_workspace_source_message_record_idx'),
        ('index', 'source_message_workspace_created_at_idx'),
        ('index', 'source_message_workspace_id_unique'),
        ('index', 'source_message_workspace_legacy_reference_unique'),
        ('index', 'source_message_provider_identity_unique'),
        ('index', 'commitment_audit_event_workspace_commitment_occurred_idx'),
        ('index', 'commitment_audit_event_workspace_occurred_idx'),
        ('index', 'async_job_workspace_idempotency_unique'),
        ('index', 'async_job_status_available_at_idx'),
        ('index', 'async_job_workspace_status_created_idx'),
        ('index', 'background_worker_queue_heartbeat_idx'),
        ('constraint', 'source_message_identity_shape'),
        ('constraint', 'source_message_provider_identifiers_nonempty'),
        ('constraint', 'commitment_workspace_source_message_record_fk'),
        ('constraint', 'commitment_workspace_legacy_source_message_fk'),
        ('constraint', 'commitment_source_message_reference_xor'),
        ('constraint', 'async_job_idempotency_key_format'),
        ('constraint', 'async_job_correlation_id_format'),
        ('constraint', 'async_job_error_code_format'),
        ('trigger', 'commitment_audit_event_no_update_or_delete'),
        ('trigger', 'commitment_audit_event_no_truncate'),
        ('trigger', 'workspace_audit_event_no_update_or_delete'),
        ('trigger', 'workspace_audit_event_no_truncate')
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
