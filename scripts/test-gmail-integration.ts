import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { GMAIL_OAUTH_STATE_TTL_MS, GMAIL_REQUIRED_SCOPES } from '../src/integrations/gmail/model';
import {
  createGmailIntegrationService,
  createGmailOAuthStateStore,
  GmailIntegrationBusyError,
  GmailRefreshTokenMissingError,
  parseGmailStoredCredentials,
} from '../src/integrations/gmail/service-core';
import { decryptIntegrationSecret } from '../src/integrations/secret-crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Set DATABASE_URL before running Gmail integration checks.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'commitmentos-gmail-integration-test',
});
const database = drizzle(pool, { schema });
const stateStore = createGmailOAuthStateStore(database);
const integrationService = createGmailIntegrationService(database);
const encryptionKey = randomBytes(32);
const workspaceId = randomUUID();
const userId = randomUUID();

function opaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

async function assertAuditMutationRejected(query: string, values: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SAVEPOINT gmail_audit_mutation');
    let rejected = false;
    try {
      await client.query(query, values);
    } catch {
      rejected = true;
    }
    await client.query('ROLLBACK TO SAVEPOINT gmail_audit_mutation');
    await client.query('COMMIT');
    assert.equal(rejected, true, 'The Gmail audit trigger must reject this mutation.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

try {
  await pool.query(`INSERT INTO commitmentos.workspace (id, name) VALUES ($1, $2)`, [
    workspaceId,
    'Gmail OAuth state integration workspace',
  ]);
  await pool.query(
    `INSERT INTO commitmentos."user" (id, name, email, email_verified)
     VALUES ($1, $2, $3, TRUE)`,
    [userId, 'Gmail OAuth State Test User', `gmail-state-${userId}@example.test`],
  );
  const auditTriggers = await pool.query(
    `SELECT tgname
     FROM pg_trigger
     WHERE tgrelid = 'commitmentos.gmail_integration_audit_event'::regclass
       AND NOT tgisinternal
     ORDER BY tgname`,
  );
  assert.deepEqual(
    auditTriggers.rows.map((row) => row.tgname),
    [
      'gmail_integration_audit_event_no_truncate',
      'gmail_integration_audit_event_no_update_or_delete',
    ],
    'Gmail integration audit history must reject update, delete, and truncate mutations.',
  );

  const firstState = opaqueValue();
  const firstBrowserToken = opaqueValue();
  const firstNonce = opaqueValue();
  const firstVerifier = opaqueValue(48);
  await stateStore.create({
    workspaceId,
    userId,
    state: firstState,
    browserToken: firstBrowserToken,
    nonce: firstNonce,
    codeVerifier: firstVerifier,
    encryptionKey,
  });

  const storedState = await pool.query(
    `SELECT state_hash, browser_token_hash, oidc_nonce_hash, code_verifier_ciphertext, expires_at
     FROM commitmentos.gmail_oauth_state
     WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  assert.equal(storedState.rows.length, 1);
  assert.equal(
    storedState.rows[0].state_hash,
    createHash('sha256').update(firstState).digest('hex'),
    'The database stores a one-way hash instead of the raw OAuth state.',
  );
  assert.equal(
    storedState.rows[0].browser_token_hash,
    createHash('sha256').update(firstBrowserToken).digest('hex'),
    'The database stores a one-way hash instead of the browser-binding cookie.',
  );
  assert.notEqual(storedState.rows[0].state_hash, firstState);
  assert.notEqual(storedState.rows[0].browser_token_hash, firstBrowserToken);
  assert.equal(
    storedState.rows[0].oidc_nonce_hash,
    createHash('sha256').update(firstNonce).digest('hex'),
    'The database stores only a one-way hash of the OIDC nonce.',
  );
  assert.notEqual(storedState.rows[0].oidc_nonce_hash, firstNonce);
  assert.ok(
    !storedState.rows[0].code_verifier_ciphertext.includes(firstVerifier),
    'The short-lived PKCE verifier must be encrypted at rest.',
  );
  assert.equal(
    decryptIntegrationSecret(
      storedState.rows[0].code_verifier_ciphertext,
      encryptionKey,
      `commitmentos:gmail-oauth-state:${storedState.rows[0].state_hash}`,
    ),
    firstVerifier,
  );
  assert.ok(storedState.rows[0].expires_at instanceof Date);
  assert.ok(storedState.rows[0].expires_at.getTime() > Date.now());

  const wrongBrowser = await stateStore.consume({
    state: firstState,
    browserToken: opaqueValue(),
  });
  assert.equal(wrongBrowser, null, 'OAuth state must be bound to the initiating browser.');

  const consumedConcurrently = await Promise.all([
    stateStore.consume({ state: firstState, browserToken: firstBrowserToken }),
    stateStore.consume({ state: firstState, browserToken: firstBrowserToken }),
  ]);
  assert.equal(
    consumedConcurrently.filter(Boolean).length,
    1,
    'Concurrent callback replays must atomically consume the state at most once.',
  );
  const acceptedFlow = consumedConcurrently.find((flow) => flow !== null);
  assert.deepEqual(acceptedFlow, {
    workspaceId,
    userId,
    stateHash: storedState.rows[0].state_hash,
    oidcNonceHash: storedState.rows[0].oidc_nonce_hash,
    codeVerifierCiphertext: storedState.rows[0].code_verifier_ciphertext,
  });
  assert.equal(
    decryptIntegrationSecret(
      acceptedFlow?.codeVerifierCiphertext ?? '',
      encryptionKey,
      `commitmentos:gmail-oauth-state:${acceptedFlow?.stateHash ?? ''}`,
    ),
    firstVerifier,
  );
  const consumedStateRow = await pool.query(
    'SELECT COUNT(*)::int AS count FROM commitmentos.gmail_oauth_state WHERE state_hash = $1',
    [storedState.rows[0].state_hash],
  );
  assert.equal(consumedStateRow.rows[0].count, 0, 'Redeemed PKCE material is removed immediately.');
  assert.equal(
    await stateStore.consume({ state: firstState, browserToken: firstBrowserToken }),
    null,
    'A consumed OAuth state cannot be replayed.',
  );

  const expiredState = opaqueValue();
  const expiredBrowserToken = opaqueValue();
  const expiredNonce = opaqueValue();
  const expiredVerifier = opaqueValue(48);
  await stateStore.create({
    workspaceId,
    userId,
    state: expiredState,
    browserToken: expiredBrowserToken,
    nonce: expiredNonce,
    codeVerifier: expiredVerifier,
    encryptionKey,
    now: new Date(Date.now() - GMAIL_OAUTH_STATE_TTL_MS - 5_000),
  });
  assert.equal(
    await stateStore.consume({ state: expiredState, browserToken: expiredBrowserToken }),
    null,
    'Expired OAuth state must not be redeemed.',
  );

  const replacedState = opaqueValue();
  const replacedBrowserToken = opaqueValue();
  const replacedNonce = opaqueValue();
  const replacedVerifier = opaqueValue(48);
  await stateStore.create({
    workspaceId,
    userId,
    state: replacedState,
    browserToken: replacedBrowserToken,
    nonce: replacedNonce,
    codeVerifier: replacedVerifier,
    encryptionKey,
  });
  const expiredStateRow = await pool.query(
    'SELECT COUNT(*)::int AS count FROM commitmentos.gmail_oauth_state WHERE state_hash = $1',
    [createHash('sha256').update(expiredState).digest('hex')],
  );
  assert.equal(expiredStateRow.rows[0].count, 0, 'A later OAuth start purges expired PKCE state.');
  const currentState = opaqueValue();
  const currentBrowserToken = opaqueValue();
  const currentNonce = opaqueValue();
  const currentVerifier = opaqueValue(48);
  await stateStore.create({
    workspaceId,
    userId,
    state: currentState,
    browserToken: currentBrowserToken,
    nonce: currentNonce,
    codeVerifier: currentVerifier,
    encryptionKey,
  });
  assert.equal(
    await stateStore.consume({ state: replacedState, browserToken: replacedBrowserToken }),
    null,
    'Starting a replacement authorization invalidates the previous pending state.',
  );
  const currentFlow = await stateStore.consume({
    state: currentState,
    browserToken: currentBrowserToken,
  });
  assert.ok(currentFlow);
  assert.equal(
    decryptIntegrationSecret(
      currentFlow.codeVerifierCiphertext,
      encryptionKey,
      `commitmentos:gmail-oauth-state:${currentFlow.stateHash}`,
    ),
    currentVerifier,
  );

  const providerAccountId = `synthetic-google-subject-${randomUUID()}`;
  const providerEmail = `gmail-${randomUUID()}@example.test`;
  const accessToken = 'synthetic-access-token-not-from-a-provider';
  const refreshToken = 'synthetic-refresh-token-not-from-a-provider';
  const accessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const connectionInput = {
    workspaceId,
    actorUserId: userId,
    providerAccountId,
    providerEmail,
    scopes: [...GMAIL_REQUIRED_SCOPES].reverse(),
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    encryptionKey,
  };
  const connected = await integrationService.connect(connectionInput);
  const storedConnection = await pool.query(
    `SELECT id, status, scopes, credentials_ciphertext, access_token_expires_at
     FROM commitmentos.gmail_integration
     WHERE workspace_id = $1 AND provider_account_id = $2`,
    [workspaceId, providerAccountId],
  );
  assert.equal(storedConnection.rows.length, 1);
  assert.equal(storedConnection.rows[0].id, connected.integrationId);
  assert.equal(storedConnection.rows[0].status, 'CONNECTED');
  assert.equal(storedConnection.rows[0].scopes, [...GMAIL_REQUIRED_SCOPES].sort().join(' '));
  assert.ok(!storedConnection.rows[0].credentials_ciphertext.includes(accessToken));
  assert.ok(!storedConnection.rows[0].credentials_ciphertext.includes(refreshToken));
  assert.deepEqual(
    parseGmailStoredCredentials(
      storedConnection.rows[0].credentials_ciphertext,
      encryptionKey,
      `commitmentos:gmail-integration:${workspaceId}:${providerAccountId}`,
    ),
    { accessToken, refreshToken },
  );
  assert.equal((await integrationService.list(workspaceId))[0]?.providerEmail, providerEmail);
  assert.deepEqual(await integrationService.list(randomUUID()), []);
  assert.deepEqual(
    await integrationService.beginRevocation({
      workspaceId: randomUUID(),
      integrationId: connected.integrationId,
      actorUserId: userId,
    }),
    { status: 'not-found' },
    'Revocation lookup must be workspace-scoped.',
  );

  assert.deepEqual(
    await integrationService.beginRevocation({
      workspaceId,
      integrationId: connected.integrationId,
      actorUserId: userId,
    }),
    {
      status: 'pending',
      credentialsCiphertext: storedConnection.rows[0].credentials_ciphertext,
      providerAccountId,
    },
  );
  await assert.rejects(
    integrationService.connect({ ...connectionInput, refreshToken: 'other-refresh-token' }),
    GmailIntegrationBusyError,
  );
  await integrationService.failRevocation({
    workspaceId,
    integrationId: connected.integrationId,
    actorUserId: userId,
  });
  assert.equal(
    await integrationService.completeRevocation({
      workspaceId,
      integrationId: connected.integrationId,
      actorUserId: userId,
    }),
    true,
  );
  const auditCountAfterDisconnect = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM commitmentos.gmail_integration_audit_event
     WHERE integration_id = $1`,
    [connected.integrationId],
  );
  await integrationService.failRevocation({
    workspaceId,
    integrationId: connected.integrationId,
    actorUserId: userId,
  });
  const auditCountAfterLateFailure = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM commitmentos.gmail_integration_audit_event
     WHERE integration_id = $1`,
    [connected.integrationId],
  );
  assert.equal(
    auditCountAfterLateFailure.rows[0].count,
    auditCountAfterDisconnect.rows[0].count,
    'A late provider failure must not append a false revocation event after disconnect.',
  );
  assert.equal(
    await integrationService.completeRevocation({
      workspaceId,
      integrationId: connected.integrationId,
      actorUserId: userId,
    }),
    false,
    'A completed revocation cannot be applied twice.',
  );
  const disconnectedConnection = await pool.query(
    `SELECT status, credentials_ciphertext, access_token_expires_at
     FROM commitmentos.gmail_integration
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, connected.integrationId],
  );
  assert.deepEqual(disconnectedConnection.rows[0], {
    status: 'DISCONNECTED',
    credentials_ciphertext: null,
    access_token_expires_at: null,
  });
  await assert.rejects(
    integrationService.connect({ ...connectionInput, refreshToken: undefined }),
    GmailRefreshTokenMissingError,
  );

  const reconnected = await integrationService.connect({
    ...connectionInput,
    refreshToken: 'synthetic-new-refresh-token-not-from-a-provider',
  });
  assert.equal(reconnected.integrationId, connected.integrationId);
  const auditDetails = await pool.query(
    `SELECT event_type, details::text AS details
     FROM commitmentos.gmail_integration_audit_event
     WHERE integration_id = $1
     ORDER BY occurred_at, id`,
    [connected.integrationId],
  );
  assert.deepEqual(
    auditDetails.rows.map((row) => row.event_type).sort(),
    [
      'CONNECTED',
      'CONNECTED',
      'DISCONNECTED',
      'REVOCATION_ATTEMPT_FAILED',
      'REVOCATION_REQUESTED',
    ].sort(),
  );
  const serializedAudit = JSON.stringify(auditDetails.rows);
  assert.ok(!serializedAudit.includes(accessToken));
  assert.ok(!serializedAudit.includes(refreshToken));

  await assertAuditMutationRejected(
    `UPDATE commitmentos.gmail_integration_audit_event
     SET details = jsonb_build_object('mutated', true)
     WHERE integration_id = $1`,
    [connected.integrationId],
  );
  await assertAuditMutationRejected(
    'DELETE FROM commitmentos.gmail_integration_audit_event WHERE integration_id = $1',
    [connected.integrationId],
  );
  await assertAuditMutationRejected('TRUNCATE commitmentos.gmail_integration_audit_event');

  console.log(
    'Gmail OAuth state, encrypted integration lifecycle, workspace scoping, and immutable audit checks passed against real PostgreSQL.',
  );
} finally {
  try {
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query(
        'ALTER TABLE commitmentos.gmail_integration_audit_event DISABLE TRIGGER USER',
      );
      await cleanup.query(
        'DELETE FROM commitmentos.gmail_integration_audit_event WHERE workspace_id = $1',
        [workspaceId],
      );
      await cleanup.query(
        'ALTER TABLE commitmentos.gmail_integration_audit_event ENABLE TRIGGER USER',
      );
      await cleanup.query('DELETE FROM commitmentos.gmail_integration WHERE workspace_id = $1', [
        workspaceId,
      ]);
      await cleanup.query('DELETE FROM commitmentos.workspace WHERE id = $1', [workspaceId]);
      await cleanup.query('DELETE FROM commitmentos."user" WHERE id = $1', [userId]);
      await cleanup.query('COMMIT');
    } catch (error) {
      await cleanup.query('ROLLBACK').catch(() => undefined);
      console.error('Gmail integration test cleanup failed.', error);
      process.exitCode = 1;
    } finally {
      cleanup.release();
    }
  } finally {
    await pool.end();
  }
}
