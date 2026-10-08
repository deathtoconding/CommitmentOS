import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createWorkspaceCommitment, updateWorkspaceCommitment } from '../src/commitments/service';
import { databasePool } from '../src/db/client';
import {
  recordSourceMessage,
  SourceMessageProviderTimestampConflictError,
} from '../src/source-messages/service';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Set DATABASE_URL before running source-message integration checks.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'commitmentos-source-message-integration-test',
});
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

async function testLegacyReferenceMigration(): Promise<void> {
  const migrationSchema = `source_message_migration_${randomUUID().replaceAll('-', '')}`;
  const quotedSchema = `"${migrationSchema}"`;
  const migrationPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../drizzle/0011_source_message_identity.sql',
  );
  const migration = readFileSync(migrationPath, 'utf8').replaceAll('"commitmentos"', quotedSchema);
  const legacyReference = 'opaque/provider-reference:Keep-Exact/Case';

  await pool.query(`CREATE SCHEMA ${quotedSchema}`);
  try {
    await pool.query(`
      CREATE TABLE ${quotedSchema}.workspace (
        id text PRIMARY KEY
      );
      CREATE TABLE ${quotedSchema}.commitment (
        id text PRIMARY KEY,
        workspace_id text NOT NULL REFERENCES ${quotedSchema}.workspace(id) ON DELETE CASCADE,
        source_message_id text
      );
    `);
    await pool.query(`INSERT INTO ${quotedSchema}.workspace (id) VALUES ($1), ($2)`, [
      'legacy-workspace-one',
      'legacy-workspace-two',
    ]);
    await pool.query(
      `INSERT INTO ${quotedSchema}.commitment (id, workspace_id, source_message_id)
       VALUES
         ('legacy-one', 'legacy-workspace-one', $1),
         ('legacy-two', 'legacy-workspace-one', $1),
         ('legacy-other-workspace', 'legacy-workspace-two', $1),
         ('legacy-only-in-one', 'legacy-workspace-one', 'only-in-workspace-one'),
         ('legacy-unknown-source', 'legacy-workspace-one', NULL)`,
      [legacyReference],
    );

    await pool.query(migration);

    const migrated = await pool.query(
      `SELECT commitment.id, commitment.workspace_id, commitment.source_message_id,
              commitment.source_message_record_id, source_message.id AS source_record_id,
              source_message.provider, source_message.provider_account_id,
              source_message.provider_message_id, source_message.provider_timestamp,
              source_message.legacy_reference, source_message.created_at
       FROM ${quotedSchema}.commitment AS commitment
       LEFT JOIN ${quotedSchema}.source_message AS source_message
         ON source_message.workspace_id = commitment.workspace_id
        AND source_message.legacy_reference = commitment.source_message_id
       ORDER BY commitment.id`,
    );
    assert.equal(migrated.rows.length, 5);

    const byId = new Map(migrated.rows.map((row) => [row.id, row]));
    const first = byId.get('legacy-one');
    const duplicate = byId.get('legacy-two');
    const otherWorkspace = byId.get('legacy-other-workspace');
    const onlyInOneWorkspace = byId.get('legacy-only-in-one');
    const noSource = byId.get('legacy-unknown-source');
    assert.ok(first && duplicate && otherWorkspace && onlyInOneWorkspace && noSource);
    assert.equal(first.source_message_id, legacyReference);
    assert.equal(duplicate.source_message_id, legacyReference);
    assert.equal(first.legacy_reference, legacyReference);
    assert.equal(duplicate.legacy_reference, legacyReference);
    assert.equal(first.source_record_id, duplicate.source_record_id);
    assert.notEqual(first.source_record_id, otherWorkspace.source_record_id);
    assert.equal(first.source_message_record_id, null);
    assert.equal(otherWorkspace.source_message_record_id, null);
    for (const row of [first, otherWorkspace]) {
      assert.equal(row.provider, null);
      assert.equal(row.provider_account_id, null);
      assert.equal(row.provider_message_id, null);
      assert.equal(row.provider_timestamp, null);
      assert.ok(row.created_at instanceof Date);
    }
    assert.equal(noSource.source_record_id, null);
    assert.equal(noSource.source_message_id, null);

    const legacyCount = await pool.query(
      `SELECT count(*)::int AS count FROM ${quotedSchema}.source_message`,
    );
    assert.equal(
      legacyCount.rows[0].count,
      3,
      'Migration must create one opaque legacy record per distinct workspace/reference pair.',
    );

    const firstWorkspaceRecordId = first.source_record_id;
    await assert.rejects(
      pool.query(
        `UPDATE ${quotedSchema}.commitment
         SET source_message_id = NULL, source_message_record_id = $1
         WHERE id = 'legacy-other-workspace'`,
        [firstWorkspaceRecordId],
      ),
      (error) => errorCode(error) === '23503',
      'A source record from a different workspace must fail the composite foreign key.',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ${quotedSchema}.commitment (id, workspace_id, source_message_id)
         VALUES ('cross-workspace-legacy-reference', 'legacy-workspace-two', 'only-in-workspace-one')`,
      ),
      (error) => errorCode(error) === '23503',
      'A legacy reference from a different workspace must fail the composite foreign key.',
    );

    console.log(
      'Source-message migration preserves exact legacy references without invented facts.',
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
  }
}

async function testIdempotentTenantScopedPersistence(): Promise<void> {
  await pool.query(`INSERT INTO commitmentos.workspace (id, name) VALUES ($1, $2), ($3, $4)`, [
    workspaceId,
    'Source-message integration workspace',
    otherWorkspaceId,
    'Other integration workspace',
  ]);
  await pool.query(
    `INSERT INTO commitmentos."user" (id, name, email, email_verified)
     VALUES ($1, $2, $3, TRUE), ($4, $5, $6, TRUE)`,
    [
      userId,
      'Source Message Test User',
      `source-message-${userId}@example.test`,
      otherUserId,
      'Other Source Message Test User',
      `source-message-${otherUserId}@example.test`,
    ],
  );
  await pool.query(
    `INSERT INTO commitmentos.workspace_member (id, workspace_id, user_id, role)
     VALUES ($1, $2, $3, 'OWNER'), ($4, $5, $6, 'OWNER')`,
    [randomUUID(), workspaceId, userId, randomUUID(), otherWorkspaceId, otherUserId],
  );

  const identity = {
    provider: 'GMAIL' as const,
    providerAccountId: 'account:Tenant-A',
    providerMessageId: 'Message/Case-Sensitive_001',
  };
  const [concurrentFirst, concurrentRetry] = await Promise.all([
    recordSourceMessage(workspaceId, identity),
    recordSourceMessage(workspaceId, identity),
  ]);
  assert.equal(concurrentFirst.sourceMessage.id, concurrentRetry.sourceMessage.id);
  assert.deepEqual(
    [concurrentFirst.status, concurrentRetry.status].sort(),
    ['created', 'existing'],
    'Concurrent duplicate deliveries must create one durable record.',
  );
  assert.equal(concurrentFirst.sourceMessage.providerTimestamp, null);
  assert.equal(concurrentFirst.sourceMessage.legacyReference, null);

  const timestamp = '2026-10-08T12:30:00.000Z';
  const timestampEnrichment = await recordSourceMessage(workspaceId, {
    ...identity,
    providerTimestamp: timestamp,
  });
  assert.equal(timestampEnrichment.status, 'existing');
  assert.equal(timestampEnrichment.sourceMessage.id, concurrentFirst.sourceMessage.id);
  assert.equal(timestampEnrichment.sourceMessage.providerTimestamp?.toISOString(), timestamp);

  const replay = await recordSourceMessage(workspaceId, {
    ...identity,
    providerTimestamp: timestamp,
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.sourceMessage.id, concurrentFirst.sourceMessage.id);
  await assert.rejects(
    recordSourceMessage(workspaceId, {
      ...identity,
      providerTimestamp: '2026-10-08T12:31:00.000Z',
    }),
    SourceMessageProviderTimestampConflictError,
    'A retry must not overwrite an already-known, conflicting provider timestamp.',
  );

  const alternateProviderAccount = await recordSourceMessage(workspaceId, {
    ...identity,
    providerAccountId: 'account:Tenant-B',
  });
  assert.notEqual(
    alternateProviderAccount.sourceMessage.id,
    concurrentFirst.sourceMessage.id,
    'The provider account is part of the deduplication identity.',
  );
  const sameExternalIdentityInOtherWorkspace = await recordSourceMessage(
    otherWorkspaceId,
    identity,
  );
  assert.notEqual(
    sameExternalIdentityInOtherWorkspace.sourceMessage.id,
    concurrentFirst.sourceMessage.id,
    'The same external identifiers in another workspace must remain a separate tenant record.',
  );
  const caseDistinctIdentity = await recordSourceMessage(workspaceId, {
    ...identity,
    providerMessageId: 'message/case-sensitive_001',
  });
  assert.notEqual(
    caseDistinctIdentity.sourceMessage.id,
    concurrentFirst.sourceMessage.id,
    'Provider IDs are not lowercased or otherwise normalized.',
  );

  const committed = await createWorkspaceCommitment(workspaceId, userId, {
    commitmentText: 'Send a source-linked proposal.',
    normalizedAction: 'Send the proposal',
    sourceMessageRecordId: concurrentFirst.sourceMessage.id,
  });
  assert.equal(committed.status, 'created');
  if (committed.status !== 'created') throw new Error('Expected a workspace-scoped commitment.');
  assert.equal(committed.commitment.sourceMessageRecordId, concurrentFirst.sourceMessage.id);
  assert.equal(committed.commitment.sourceMessageId, null);

  const legacyReference = 'preserved-legacy-reference';
  const legacyCommitmentId = randomUUID();
  await pool.query(
    `INSERT INTO commitmentos.source_message (id, workspace_id, legacy_reference)
     VALUES ($1, $2, $3)`,
    [randomUUID(), workspaceId, legacyReference],
  );
  await pool.query(
    `INSERT INTO commitmentos.commitment (
       id, workspace_id, source_message_id, commitment_text, normalized_action, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      legacyCommitmentId,
      workspaceId,
      legacyReference,
      'A historical commitment must keep its original opaque source.',
      'Keep the legacy source relationship',
      userId,
    ],
  );
  const updateLegacySource = await updateWorkspaceCommitment(
    workspaceId,
    userId,
    legacyCommitmentId,
    { sourceMessageRecordId: concurrentFirst.sourceMessage.id },
  );
  assert.deepEqual(
    updateLegacySource,
    { status: 'source-message-conflict' },
    'A legacy link must not be silently replaced by a new source record.',
  );

  const crossWorkspaceCommitment = await createWorkspaceCommitment(otherWorkspaceId, otherUserId, {
    commitmentText: 'This must not link a different tenant source.',
    normalizedAction: 'Reject cross-workspace link',
    sourceMessageRecordId: concurrentFirst.sourceMessage.id,
  });
  assert.deepEqual(crossWorkspaceCommitment, { status: 'source-message-not-found' });

  const unlinkedCommitment = await createWorkspaceCommitment(otherWorkspaceId, otherUserId, {
    commitmentText: 'This commitment begins without a source link.',
    normalizedAction: 'Preserve unknown source',
  });
  assert.equal(unlinkedCommitment.status, 'created');
  if (unlinkedCommitment.status !== 'created') throw new Error('Expected an unlinked commitment.');
  const updateCrossWorkspace = await updateWorkspaceCommitment(
    otherWorkspaceId,
    otherUserId,
    unlinkedCommitment.commitment.id,
    { sourceMessageRecordId: concurrentFirst.sourceMessage.id },
  );
  assert.deepEqual(updateCrossWorkspace, { status: 'source-message-not-found' });

  await assert.rejects(
    pool.query(
      `INSERT INTO commitmentos.commitment (
         id, workspace_id, commitment_text, normalized_action, created_by, source_message_record_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        otherWorkspaceId,
        'Cross-workspace reference must fail.',
        'Reject source association',
        otherUserId,
        concurrentFirst.sourceMessage.id,
      ],
    ),
    (error) => errorCode(error) === '23503',
    'PostgreSQL must reject cross-workspace source associations even when application checks are bypassed.',
  );

  const providerRows = await pool.query(
    `SELECT count(*)::int AS count
     FROM commitmentos.source_message
     WHERE workspace_id = $1 AND provider = 'GMAIL'
       AND provider_account_id = $2 AND provider_message_id = $3`,
    [workspaceId, identity.providerAccountId, identity.providerMessageId],
  );
  assert.equal(providerRows.rows[0].count, 1, 'A retried provider message must occupy one row.');

  const sourceColumns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'commitmentos' AND table_name = 'source_message'`,
  );
  const sourceColumnNames = new Set(sourceColumns.rows.map((row) => row.column_name));
  for (const prohibitedColumn of ['body', 'raw_body', 'subject', 'snippet', 'headers']) {
    assert.equal(
      sourceColumnNames.has(prohibitedColumn),
      false,
      `The source-message table must not persist ${prohibitedColumn}.`,
    );
  }
}

try {
  await testLegacyReferenceMigration();
  await testIdempotentTenantScopedPersistence();
  console.log(
    'PostgreSQL source-message integration checks passed: legacy migration, provider/account identity, concurrent deduplication, retry-safe metadata, tenant isolation, and commitment association.',
  );
} catch (error) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message =
    error instanceof Error ? error.message : 'Unknown source-message integration failure.';
  console.error(`Source-message integration checks failed (${name}): ${message}`);
  process.exitCode = 1;
} finally {
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
    await cleanupClient.query(
      'ALTER TABLE commitmentos.commitment_audit_event DISABLE TRIGGER USER',
    );
    await cleanupClient.query(
      'DELETE FROM commitmentos.commitment_audit_event WHERE workspace_id = ANY($1::text[])',
      [[workspaceId, otherWorkspaceId]],
    );
    await cleanupClient.query(
      'ALTER TABLE commitmentos.commitment_audit_event ENABLE TRIGGER USER',
    );
    await cleanupClient.query(
      'DELETE FROM commitmentos.commitment WHERE workspace_id = ANY($1::text[])',
      [[workspaceId, otherWorkspaceId]],
    );
    await cleanupClient.query(
      'DELETE FROM commitmentos.source_message WHERE workspace_id = ANY($1::text[])',
      [[workspaceId, otherWorkspaceId]],
    );
    await cleanupClient.query(
      'DELETE FROM commitmentos.workspace_member WHERE workspace_id = ANY($1::text[])',
      [[workspaceId, otherWorkspaceId]],
    );
    await cleanupClient.query('DELETE FROM commitmentos.workspace WHERE id = ANY($1::text[])', [
      [workspaceId, otherWorkspaceId],
    ]);
    await cleanupClient.query('DELETE FROM commitmentos."user" WHERE id = ANY($1::text[])', [
      [userId, otherUserId],
    ]);
    await cleanupClient.query('COMMIT');
  } catch (error) {
    await cleanupClient.query('ROLLBACK').catch(() => undefined);
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : 'Unknown cleanup failure.';
    console.error(`Source-message integration cleanup failed (${name}): ${message}`);
    process.exitCode = 1;
  } finally {
    cleanupClient.release();
    await pool.end();
    await databasePool.end();
  }
}
