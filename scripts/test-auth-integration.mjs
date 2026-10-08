import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';

const { Pool } = pg;
const port = Number(process.env.AUTH_E2E_PORT ?? 3141);
const baseURL = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.DATABASE_URL;
const authSecret = process.env.BETTER_AUTH_SECRET;

if (!databaseUrl || !authSecret) {
  throw new Error('Set DATABASE_URL and BETTER_AUTH_SECRET before running integration tests.');
}

const email = `commitmentos.test+${randomUUID()}@example.com`;
const secondEmail = `commitmentos.test+${randomUUID()}@example.com`;
const recoveryEmail = `commitmentos.test+${randomUUID()}@example.com`;
const resetEmailDeliveryDelayMs = 500;
const testEmails = [email, secondEmail, recoveryEmail];
const password = 'CommitmentOS-Test-Password-2026!';
const resetPassword = 'CommitmentOS-Recovered-Password-2026!';
const smtpPort = Number(process.env.AUTH_E2E_SMTP_PORT ?? 3142);
const smtpUser = process.env.SMTP_USER ?? 'commitmentos-integration';
const smtpPassword = process.env.SMTP_PASSWORD ?? 'commitmentos-integration-smtp-secret';
const emailFrom = process.env.EMAIL_FROM ?? 'noreply@commitmentos.test';
const emailTlsDirectory = mkdtempSync(join(tmpdir(), 'commitmentos-smtp-'));
const emailTlsKeyPath = join(emailTlsDirectory, 'server.key');
const emailTlsCertificatePath = join(emailTlsDirectory, 'server.crt');
const emailMessages = [];
const verificationTokenHashes = [];
const rateLimitTestIps = ['198.51.100.71', '198.51.100.72', '198.51.100.73', '198.51.100.74'];
const workspaceIds = [];
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'commitmentos-integration-test',
});
let server;
let smtpServer;
let serverOutput = '';

function appendServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-4000);
}

async function startEmailServer() {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      emailTlsKeyPath,
      '-out',
      emailTlsCertificatePath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );

  smtpServer = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN'],
    authOptional: false,
    cert: readFileSync(emailTlsCertificatePath),
    key: readFileSync(emailTlsKeyPath),
    onAuth(auth, _session, callback) {
      if (auth.username !== smtpUser || auth.password !== smtpPassword) {
        callback(new Error('SMTP test authentication failed.'));
        return;
      }
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', callback);
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        void (async () => {
          if (decodeQuotedPrintable(raw).includes('/api/auth/reset-password/')) {
            await delay(resetEmailDeliveryDelayMs);
          }
          emailMessages.push({
            recipient: session.envelope.rcptTo[0]?.address?.toLowerCase(),
            raw,
          });
          callback(null, 'Accepted for integration delivery.');
        })().catch(callback);
      });
    },
  });

  await new Promise((resolveServer, rejectServer) => {
    smtpServer.once('error', rejectServer);
    smtpServer.listen(smtpPort, '127.0.0.1', () => {
      smtpServer.removeListener('error', rejectServer);
      resolveServer();
    });
  });
}

function decodeQuotedPrintable(value) {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function storedVerificationIdentifier(identifier) {
  return createHash('sha256').update(identifier).digest('base64url');
}

async function emailLinkFor(recipient, pathFragment, minimumDeliveryCount = 1) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const matchingMessages = emailMessages.filter(
      (delivery) =>
        delivery.recipient === recipient.toLowerCase() &&
        decodeQuotedPrintable(delivery.raw).includes(pathFragment),
    );
    const message =
      matchingMessages.length >= minimumDeliveryCount ? matchingMessages.at(-1) : null;
    const decodedMessage = message ? decodeQuotedPrintable(message.raw) : '';
    const links = decodedMessage.match(/https?:\/\/[^\s<>"']+/g) ?? [];
    const link = links
      .map((value) => value.replace(/[),.]+$/, ''))
      .find((value) => value.includes(pathFragment));
    if (link) return link;
    await delay(50);
  }

  throw new Error(`No matching authentication link was delivered to ${recipient}.`);
}

async function verificationLinkFor(recipient, minimumDeliveryCount = 1) {
  return emailLinkFor(recipient, '/verify-email?', minimumDeliveryCount);
}

async function passwordResetLinkFor(recipient) {
  return emailLinkFor(recipient, '/reset-password/');
}

async function followVerificationLink(
  recipient,
  { concurrent = false, afterDeliveryCount = 0 } = {},
) {
  const verificationLink = await verificationLinkFor(recipient, afterDeliveryCount + 1);
  const verificationUrl = new URL(verificationLink);
  const token = verificationUrl.searchParams.get('token');
  assert.ok(token);
  assert.equal(verificationUrl.searchParams.get('callbackURL'), '/login?verified=1');

  const redeem = () => fetch(verificationUrl, { redirect: 'manual' });
  let verificationResponse;
  if (concurrent) {
    const concurrentResponses = await Promise.all([redeem(), redeem()]);
    assert.deepEqual(
      concurrentResponses.map((response) => response.status).sort((left, right) => left - right),
      [302, 400],
      'Concurrent verification attempts must allow exactly one successful redemption.',
    );
    verificationResponse = concurrentResponses.find((response) => response.status === 302);
    const replayResponse = concurrentResponses.find((response) => response.status === 400);
    assert.ok(verificationResponse);
    assert.ok(replayResponse);
    const replayBody = await replayResponse.json();
    assert.equal(replayBody.code, 'INVALID_TOKEN');
  } else {
    verificationResponse = await redeem();
    if (verificationResponse.status !== 302) {
      const responseBody = await verificationResponse.json().catch(() => ({}));
      const callback = verificationUrl.searchParams.get('callbackURL') ?? 'missing';
      throw new Error(
        `A valid email verification link should redirect to its configured callback (HTTP ${verificationResponse.status}, ${responseBody.code ?? 'unknown'}: ${responseBody.message ?? 'no message'}, callback ${callback}).`,
      );
    }
  }

  const callback = new URL(verificationResponse.headers.get('location') ?? '', baseURL);
  assert.equal(callback.origin, baseURL);
  assert.equal(callback.pathname, '/login');
  assert.equal(callback.searchParams.get('verified'), '1');
  verificationTokenHashes.push(createHash('sha256').update(token).digest('hex'));

  const verifiedPage = await appPageRequest('/login?verified=1');
  assert.equal(verifiedPage.status, 200);
  assert.match(await verifiedPage.text(), /Your email is verified/);
  return { link: verificationLink, token };
}

async function assertVerificationReplayRejected(link) {
  const response = await fetch(link, { redirect: 'manual' });
  assert.equal(response.status, 400, 'A used email verification link must be rejected.');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  const body = await response.json();
  assert.equal(body.code, 'INVALID_TOKEN');
}

async function cleanupEmailServer() {
  if (smtpServer?.server?.listening) {
    await new Promise((resolveServer) => smtpServer.close(resolveServer));
  }
  rmSync(emailTlsDirectory, { recursive: true, force: true });
}

function startServer() {
  const nextCli = resolve('node_modules/next/dist/bin/next');
  server = spawn(
    process.execPath,
    [nextCli, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BETTER_AUTH_URL: baseURL,
        EMAIL_FROM: emailFrom,
        NODE_ENV: 'production',
        PORT: String(port),
        SMTP_HOST: '127.0.0.1',
        SMTP_PASSWORD: smtpPassword,
        SMTP_PORT: String(smtpPort),
        SMTP_TLS_CA: emailTlsCertificatePath,
        SMTP_USER: smtpUser,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', appendServerOutput);
  server.stderr.on('data', appendServerOutput);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready. ${serverOutput}`);
    }

    try {
      const response = await fetch(`${baseURL}/login`, { redirect: 'manual' });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for the Next.js test server. ${serverOutput}`);
}

function authRequest(path, body, cookie, extraHeaders = {}) {
  return fetch(`${baseURL}/api/auth/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: baseURL,
      ...extraHeaders,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

function workspaceRequest(path, { method = 'GET', cookie, body } = {}) {
  return fetch(`${baseURL}${path}`, {
    method,
    headers: {
      origin: baseURL,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
}

function appPageRequest(path, cookie) {
  return fetch(`${baseURL}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
}

async function assertAppPageUnavailable(response, hiddenValues = []) {
  const body = await response.text();
  // A streamed not-found page can carry HTTP 200 after Next has flushed the loading shell.
  assert.ok(
    response.status === 404 || response.status === 200,
    `An inaccessible app page should return 404 or a streamed not-found response, got ${response.status}.`,
  );
  assert.match(body, /Workspace unavailable/);
  for (const hiddenValue of hiddenValues) {
    assert.ok(
      !body.includes(hiddenValue),
      `The unavailable app page must not expose ${hiddenValue}.`,
    );
  }
}

function readCookieHeader(response) {
  const cookies = response.headers.getSetCookie();
  return cookies
    .map((cookie) => cookie.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
}

async function insertCommitment({
  id = randomUUID(),
  workspaceId,
  ownerUserId = null,
  sourceMessageId = null,
  commitmentText = 'A test commitment',
  normalizedAction = 'Complete the test action',
  counterpartyName = null,
  counterpartyEmail = null,
  dueAt = null,
  dueTimezone = null,
  status = 'DETECTED',
  confidenceScore = null,
  sourceExcerpt = null,
  completionEvidence = null,
  completedAt = null,
  createdBy,
}) {
  if (sourceMessageId !== null) {
    await pool.query(
      `INSERT INTO commitmentos.source_message (id, workspace_id, legacy_reference)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, legacy_reference) DO NOTHING`,
      [randomUUID(), workspaceId, sourceMessageId],
    );
  }

  return pool.query(
    `INSERT INTO commitmentos.commitment (
       id, workspace_id, owner_user_id, source_message_id, source_message_record_id, commitment_text,
       normalized_action, counterparty_name, counterparty_email, due_at,
       due_timezone, status, confidence_score, source_excerpt,
       completion_evidence, completed_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
     )`,
    [
      id,
      workspaceId,
      ownerUserId,
      sourceMessageId,
      null,
      commitmentText,
      normalizedAction,
      counterpartyName,
      counterpartyEmail,
      dueAt,
      dueTimezone,
      status,
      confidenceScore,
      sourceExcerpt,
      completionEvidence,
      completedAt,
      createdBy,
    ],
  );
}

async function assertDatabaseRejects(query, values, code, message) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query(query, values), (error) => error.code === code, message);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function testCommitmentPersistence({ workspaceId, otherWorkspaceId, userId }) {
  const populatedId = randomUUID();
  const populatedDueAt = new Date('2026-11-02T09:30:00.000Z');
  await insertCommitment({
    id: populatedId,
    workspaceId,
    ownerUserId: userId,
    sourceMessageId: 'provider-message-123',
    commitmentText: 'I will send the revised proposal.',
    normalizedAction: 'Send the revised proposal',
    counterpartyName: 'Customer Example',
    counterpartyEmail: 'customer@example.test',
    dueAt: populatedDueAt,
    dueTimezone: 'Europe/Amsterdam',
    status: 'OPEN',
    confidenceScore: 0.92,
    sourceExcerpt: 'I will send the revised proposal by Monday.',
    createdBy: userId,
  });

  const sparseId = randomUUID();
  await insertCommitment({
    id: sparseId,
    workspaceId: otherWorkspaceId,
    commitmentText: 'I will follow up.',
    normalizedAction: 'Follow up',
    createdBy: userId,
  });

  const populatedResult = await pool.query('SELECT * FROM commitmentos.commitment WHERE id = $1', [
    populatedId,
  ]);
  assert.equal(populatedResult.rows.length, 1, 'A commitment should persist and be readable.');
  const populated = populatedResult.rows[0];
  assert.equal(populated.workspace_id, workspaceId);
  assert.equal(populated.owner_user_id, userId);
  assert.equal(populated.source_message_id, 'provider-message-123');
  assert.equal(populated.source_message_record_id, null);
  assert.equal(populated.commitment_text, 'I will send the revised proposal.');
  assert.equal(populated.normalized_action, 'Send the revised proposal');
  assert.equal(populated.counterparty_name, 'Customer Example');
  assert.equal(populated.counterparty_email, 'customer@example.test');
  assert.equal(populated.due_at.toISOString(), populatedDueAt.toISOString());
  assert.equal(populated.due_timezone, 'Europe/Amsterdam');
  assert.equal(populated.status, 'OPEN');
  assert.equal(populated.confidence_score, 0.92);
  assert.equal(populated.source_excerpt, 'I will send the revised proposal by Monday.');
  assert.equal(populated.completion_evidence, null);
  assert.equal(populated.completed_at, null);
  assert.equal(populated.created_by, userId);
  assert.ok(populated.created_at instanceof Date);
  assert.ok(populated.updated_at instanceof Date);

  const sparseResult = await pool.query('SELECT * FROM commitmentos.commitment WHERE id = $1', [
    sparseId,
  ]);
  assert.equal(sparseResult.rows.length, 1);
  const sparse = sparseResult.rows[0];
  assert.equal(sparse.status, 'DETECTED', 'New records should default to DETECTED.');
  for (const field of [
    'owner_user_id',
    'source_message_id',
    'counterparty_name',
    'counterparty_email',
    'due_at',
    'due_timezone',
    'confidence_score',
    'source_excerpt',
    'completion_evidence',
    'completed_at',
  ]) {
    assert.equal(sparse[field], null, `${field} should remain unknown rather than fabricated.`);
  }

  const workspaceScopedRows = await pool.query(
    'SELECT id FROM commitmentos.commitment WHERE workspace_id = $1 ORDER BY id',
    [workspaceId],
  );
  assert.deepEqual(
    workspaceScopedRows.rows.map((row) => row.id),
    [populatedId],
    "Workspace-scoped persistence must not return another workspace's commitments.",
  );
  const otherWorkspaceRows = await pool.query(
    'SELECT id FROM commitmentos.commitment WHERE workspace_id = $1 ORDER BY id',
    [otherWorkspaceId],
  );
  assert.deepEqual(
    otherWorkspaceRows.rows.map((row) => row.id),
    [sparseId],
  );

  await assert.rejects(
    insertCommitment({ workspaceId, createdBy: userId, status: 'UNKNOWN' }),
    (error) => error.code === '22P02',
    'The database must reject statuses outside the domain enum.',
  );
  await assert.rejects(
    insertCommitment({ workspaceId, createdBy: userId, confidenceScore: 1.01 }),
    (error) => error.code === '23514',
    'Confidence scores must be within the inclusive zero-to-one range.',
  );
  await assert.rejects(
    insertCommitment({ workspaceId, createdBy: userId, commitmentText: '   ' }),
    (error) => error.code === '23514',
    'Commitment text must not be blank.',
  );
  await assert.rejects(
    insertCommitment({ workspaceId: randomUUID(), createdBy: userId }),
    (error) => error.code === '23503',
    'Commitments must reference an existing workspace.',
  );
  await assert.rejects(
    insertCommitment({ workspaceId, ownerUserId: randomUUID(), createdBy: userId }),
    (error) => error.code === '23503',
    'A known owner must reference an existing user.',
  );
  await assert.rejects(
    insertCommitment({ workspaceId, createdBy: randomUUID() }),
    (error) => error.code === '23503',
    'The creator must reference an existing user.',
  );

  return { populatedId, sparseId };
}

async function testPasswordRecovery() {
  const forgotPasswordPage = await appPageRequest('/forgot-password');
  assert.equal(forgotPasswordPage.status, 200);
  assert.equal(forgotPasswordPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(forgotPasswordPage.headers.get('cache-control') ?? '', /no-store/i);
  const forgotPasswordBody = await forgotPasswordPage.text();
  assert.match(forgotPasswordBody, /Recover your account/);
  assert.match(forgotPasswordBody, /Send reset link/);
  assert.match(forgotPasswordBody, /does not confirm whether an account is registered/);

  const resetLandingPage = await appPageRequest('/reset-password?token=private-page-token');
  assert.equal(resetLandingPage.status, 200);
  assert.equal(resetLandingPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(resetLandingPage.headers.get('cache-control') ?? '', /no-store/i);
  assert.match(await resetLandingPage.text(), /Choose a new password/);
  const invalidResetLandingPage = await appPageRequest('/reset-password?error=INVALID_TOKEN');
  assert.equal(invalidResetLandingPage.status, 200);
  assert.match(await invalidResetLandingPage.text(), /Reset link unavailable/);

  const recoveryRegistration = await authRequest('sign-up/email', {
    name: 'Password Recovery Integration User',
    email: recoveryEmail,
    password,
    callbackURL: '/login?verified=1',
  });
  assert.ok(recoveryRegistration.ok, 'A password recovery fixture account should register.');
  const recoveryUser = (await recoveryRegistration.json()).user;
  assert.equal(recoveryUser.emailVerified, false);
  await followVerificationLink(recoveryEmail);

  const recoveryLogin = await authRequest('sign-in/email', { email: recoveryEmail, password });
  assert.ok(recoveryLogin.ok, 'The verified recovery fixture should be able to sign in.');
  const recoveryCookie = readCookieHeader(recoveryLogin);
  const sessionBeforeReset = await pool.query(
    'SELECT COUNT(*)::int AS count FROM commitmentos.session WHERE user_id = $1',
    [recoveryUser.id],
  );
  assert.equal(sessionBeforeReset.rows[0].count, 1);

  const recoveryRateLimitIp = rateLimitTestIps[0];
  const requestResetFor = (targetEmail) =>
    authRequest(
      'request-password-reset',
      { email: targetEmail, redirectTo: '/reset-password' },
      undefined,
      { 'x-forwarded-for': recoveryRateLimitIp },
    );
  const previousResetEmails = emailMessages.filter(
    (message) =>
      message.recipient === recoveryEmail &&
      decodeQuotedPrintable(message.raw).includes('/api/auth/reset-password/'),
  ).length;

  const knownAddressStartedAt = performance.now();
  const knownAddressRequest = await requestResetFor(recoveryEmail);
  const knownAddressDurationMs = performance.now() - knownAddressStartedAt;
  const knownAddressBody = await knownAddressRequest.json();
  assert.equal(knownAddressRequest.status, 200);
  const resetEmailsBeforeAsyncDelivery = emailMessages.filter(
    (message) =>
      message.recipient === recoveryEmail &&
      decodeQuotedPrintable(message.raw).includes('/api/auth/reset-password/'),
  ).length;
  assert.equal(
    resetEmailsBeforeAsyncDelivery,
    previousResetEmails,
    'The recovery response must not wait for SMTP delivery.',
  );
  const unknownAddressStartedAt = performance.now();
  const unknownAddressRequest = await requestResetFor(`missing+${randomUUID()}@example.com`);
  const unknownAddressDurationMs = performance.now() - unknownAddressStartedAt;
  const unknownAddressBody = await unknownAddressRequest.json();
  assert.equal(unknownAddressRequest.status, 200);
  assert.ok(
    Math.abs(knownAddressDurationMs - unknownAddressDurationMs) < resetEmailDeliveryDelayMs * 0.8,
    `Known- and unknown-account reset responses had observably different timing (${Math.round(knownAddressDurationMs)}ms vs ${Math.round(unknownAddressDurationMs)}ms).`,
  );
  assert.deepEqual(
    knownAddressBody,
    unknownAddressBody,
    'Known and unknown addresses must receive exactly the same password-reset response.',
  );
  assert.equal(knownAddressBody.status, true);
  assert.match(knownAddressBody.message, /If this email exists/);

  let resetEmailsAfterLookup = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    resetEmailsAfterLookup = emailMessages.filter(
      (message) =>
        message.recipient === recoveryEmail &&
        decodeQuotedPrintable(message.raw).includes('/api/auth/reset-password/'),
    );
    if (resetEmailsAfterLookup.length >= previousResetEmails + 1) break;
    await delay(50);
  }
  assert.equal(
    resetEmailsAfterLookup.length,
    previousResetEmails + 1,
    'A reset message should be sent only for a known account.',
  );

  const thirdAddressRequest = await requestResetFor(`missing+${randomUUID()}@example.com`);
  assert.equal(thirdAddressRequest.status, 200);
  assert.deepEqual(await thirdAddressRequest.json(), knownAddressBody);
  const rateLimitedAddressRequest = await requestResetFor(`missing+${randomUUID()}@example.com`);
  assert.equal(rateLimitedAddressRequest.status, 429);
  assert.ok(Number(rateLimitedAddressRequest.headers.get('x-retry-after')) > 0);

  const persistedRequestLimit = await pool.query(
    `SELECT count
     FROM commitmentos.rate_limit
     WHERE key LIKE $1
     LIMIT 1`,
    [`${recoveryRateLimitIp}|%request-password-reset`],
  );
  assert.equal(
    persistedRequestLimit.rows[0]?.count,
    3,
    'Password-reset throttling must be shared through PostgreSQL rather than process memory.',
  );

  const redirectAttempt = await authRequest(
    'request-password-reset',
    { email: recoveryEmail, redirectTo: 'https://attacker.example/reset' },
    undefined,
    { 'x-forwarded-for': rateLimitTestIps[1] },
  );
  assert.ok(
    [400, 403].includes(redirectAttempt.status),
    'Password-reset email callbacks must reject untrusted redirect origins.',
  );

  const oversizedResetRequest = await authRequest(
    'request-password-reset',
    { email: recoveryEmail, padding: 'x'.repeat(300_000) },
    undefined,
    { 'x-forwarded-for': rateLimitTestIps[2] },
  );
  assert.equal(oversizedResetRequest.status, 413);

  const resetLink = await passwordResetLinkFor(recoveryEmail);
  const resetUrl = new URL(resetLink);
  assert.equal(resetUrl.origin, baseURL);
  assert.match(resetUrl.pathname, /^\/api\/auth\/reset-password\//);
  assert.equal(resetUrl.searchParams.get('callbackURL'), '/reset-password');
  const resetToken = resetUrl.pathname.split('/').at(-1);
  assert.ok(resetToken);
  const resetIdentifier = storedVerificationIdentifier(`reset-password:${resetToken}`);
  const storedResetToken = await pool.query(
    'SELECT identifier FROM commitmentos.verification WHERE identifier = $1',
    [resetIdentifier],
  );
  assert.equal(storedResetToken.rows.length, 1);
  assert.equal(storedResetToken.rows[0].identifier, resetIdentifier);
  assert.notEqual(storedResetToken.rows[0].identifier, `reset-password:${resetToken}`);

  const untrustedResetCallback = new URL(resetUrl);
  untrustedResetCallback.searchParams.set('callbackURL', 'https://attacker.example/reset');
  const rejectedResetCallback = await fetch(untrustedResetCallback, { redirect: 'manual' });
  assert.ok(
    [400, 403].includes(rejectedResetCallback.status),
    'Reset links must not permit an untrusted callback origin.',
  );

  const expiredResetToken = randomUUID().replaceAll('-', '');
  const expiredResetIdentifier = storedVerificationIdentifier(
    `reset-password:${expiredResetToken}`,
  );
  const expiredResetAt = new Date(Date.now() - 60_000);
  await pool.query(
    `INSERT INTO commitmentos.verification (
       id, identifier, value, expires_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, now(), now())`,
    [randomUUID(), expiredResetIdentifier, recoveryUser.id, expiredResetAt],
  );
  const expiredResetUrl = new URL(`/api/auth/reset-password/${expiredResetToken}`, baseURL);
  expiredResetUrl.searchParams.set('callbackURL', '/reset-password');
  const expiredResetCallback = await fetch(expiredResetUrl, { redirect: 'manual' });
  assert.equal(expiredResetCallback.status, 302);
  const expiredResetLanding = new URL(expiredResetCallback.headers.get('location') ?? '', baseURL);
  assert.equal(expiredResetLanding.pathname, '/reset-password');
  assert.equal(expiredResetLanding.searchParams.get('error'), 'INVALID_TOKEN');
  assert.equal(expiredResetLanding.searchParams.has('token'), false);

  const expiredResetAttempt = await authRequest('reset-password', {
    newPassword: resetPassword,
    token: expiredResetToken,
  });
  assert.equal(expiredResetAttempt.status, 400);
  assert.equal((await expiredResetAttempt.json()).code, 'INVALID_TOKEN');
  const expiredResetRow = await pool.query(
    'SELECT COUNT(*)::int AS count FROM commitmentos.verification WHERE identifier = $1',
    [expiredResetIdentifier],
  );
  assert.equal(expiredResetRow.rows[0].count, 0);

  const resetCallback = await fetch(resetUrl, { redirect: 'manual' });
  assert.equal(resetCallback.status, 302);
  assert.equal(resetCallback.headers.get('referrer-policy'), 'no-referrer');
  assert.match(resetCallback.headers.get('cache-control') ?? '', /no-store/i);
  const resetLanding = new URL(resetCallback.headers.get('location') ?? '', baseURL);
  assert.equal(resetLanding.origin, baseURL);
  assert.equal(resetLanding.pathname, '/reset-password');
  assert.equal(resetLanding.searchParams.get('token'), resetToken);
  const validResetPage = await appPageRequest(resetLanding.pathname + resetLanding.search);
  assert.equal(validResetPage.status, 200);
  assert.equal(validResetPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(validResetPage.headers.get('cache-control') ?? '', /no-store/i);
  assert.match(await validResetPage.text(), /Choose a new password/);

  const unknownToken = randomUUID().replaceAll('-', '');
  const unknownTokenReset = await authRequest('reset-password', {
    newPassword: resetPassword,
    token: unknownToken,
  });
  assert.equal(unknownTokenReset.status, 400);
  assert.equal((await unknownTokenReset.json()).code, 'INVALID_TOKEN');

  const resetResponse = await authRequest('reset-password', {
    newPassword: resetPassword,
    token: resetToken,
  });
  assert.equal(resetResponse.status, 200, 'A valid reset link should change the account password.');
  assert.deepEqual(await resetResponse.json(), { status: true });
  const consumedResetRow = await pool.query(
    'SELECT COUNT(*)::int AS count FROM commitmentos.verification WHERE identifier = $1',
    [resetIdentifier],
  );
  assert.equal(consumedResetRow.rows[0].count, 0, 'Password reset must consume the token.');
  const sessionsAfterReset = await pool.query(
    'SELECT COUNT(*)::int AS count FROM commitmentos.session WHERE user_id = $1',
    [recoveryUser.id],
  );
  assert.equal(
    sessionsAfterReset.rows[0].count,
    0,
    'Password reset must revoke existing sessions.',
  );

  const replayedReset = await authRequest('reset-password', {
    newPassword: 'CommitmentOS-Another-Password-2026!',
    token: resetToken,
  });
  assert.equal(replayedReset.status, 400, 'A password reset token must be single-use.');
  assert.equal((await replayedReset.json()).code, 'INVALID_TOKEN');
  const previousSessionRequest = await workspaceRequest('/api/workspaces', {
    cookie: recoveryCookie,
  });
  assert.equal(previousSessionRequest.status, 401);

  const oldPasswordLogin = await authRequest('sign-in/email', {
    email: recoveryEmail,
    password,
  });
  assert.equal(oldPasswordLogin.ok, false, 'The previous password must stop working after reset.');
  const recoveredLogin = await authRequest('sign-in/email', {
    email: recoveryEmail,
    password: resetPassword,
  });
  assert.ok(recoveredLogin.ok, 'The new password should sign in successfully.');

  const resetRateLimitIp = rateLimitTestIps[3];
  const resetAbuseResponses = await Promise.all(
    Array.from({ length: 6 }, () =>
      authRequest(
        'reset-password',
        { newPassword: resetPassword, token: randomUUID().replaceAll('-', '') },
        undefined,
        { 'x-forwarded-for': resetRateLimitIp },
      ),
    ),
  );
  assert.deepEqual(
    resetAbuseResponses.map((response) => response.status).sort((left, right) => left - right),
    [400, 400, 400, 400, 400, 429],
    'Repeated invalid reset attempts must be rate-limited.',
  );
}

async function cleanupServer() {
  if (!server || server.exitCode !== null) return;

  const stopped = new Promise((resolveExit) => server.once('exit', resolveExit));
  server.kill('SIGTERM');
  await Promise.race([stopped, delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

try {
  await startEmailServer();
  startServer();
  await waitForServer();

  const anonymousPage = await fetch(`${baseURL}/app`, { redirect: 'manual' });
  assert.equal(
    anonymousPage.status,
    307,
    'Unauthenticated users must be redirected away from /app.',
  );
  assert.match(anonymousPage.headers.get('location') ?? '', /\/login$/);
  const anonymousNestedPage = await appPageRequest('/app/inbox');
  assert.equal(anonymousNestedPage.status, 307);
  assert.match(anonymousNestedPage.headers.get('location') ?? '', /\/login$/);

  const clientClaimedVerifiedRegistration = await authRequest('sign-up/email', {
    name: 'Test User',
    email,
    password,
    emailVerified: true,
  });
  assert.equal(
    clientClaimedVerifiedRegistration.status,
    400,
    'Registration must reject client-supplied email verification state.',
  );
  const invalidRegistration = await authRequest('sign-up/email', {
    name: 'Test User',
    email,
    password: 'short',
  });
  assert.equal(
    invalidRegistration.status,
    400,
    'Server-side Zod validation must reject weak passwords.',
  );
  const oversizedRegistration = await authRequest('sign-up/email', {
    name: 'x'.repeat(300_000),
    email,
    password,
  });
  assert.equal(oversizedRegistration.status, 413);

  const registration = await authRequest('sign-up/email', {
    name: 'CommitmentOS Test User',
    email,
    password,
    callbackURL: '/login?verified=1',
  });
  if (!registration.ok) {
    const responseBody = await registration.json().catch(() => ({}));
    const safeServerOutput = [authSecret, smtpPassword]
      .filter(Boolean)
      .reduce((output, secret) => output.replaceAll(secret, '[redacted]'), serverOutput);
    const responseMessage =
      typeof responseBody.message === 'string' ? `: ${responseBody.message}` : '';
    throw new Error(
      `A new account should register successfully (HTTP ${registration.status}, ${responseBody.code ?? 'unknown'}${responseMessage}). ${safeServerOutput}`,
    );
  }
  const registrationResult = await registration.json();
  assert.equal(registrationResult.user.email, email);
  assert.equal(registrationResult.user.emailVerified, false);
  const initialVerificationLink = await verificationLinkFor(email);
  assert.match(initialVerificationLink, /\/api\/auth\/verify-email\?/);

  const duplicateRegistration = await authRequest('sign-up/email', {
    name: 'Another Name',
    email,
    password: 'A-different-valid-password-2026!',
  });
  assert.ok(
    duplicateRegistration.ok,
    'Duplicate registration should use the generic success response.',
  );
  const duplicateCount = await pool.query(
    'SELECT COUNT(*)::int AS count FROM commitmentos."user" WHERE email = $1',
    [email],
  );
  assert.equal(
    duplicateCount.rows[0].count,
    1,
    'Duplicate registration must not create a second user.',
  );

  const accountPassword = await pool.query(
    `SELECT account.password
     FROM commitmentos.account AS account
     JOIN commitmentos."user" AS app_user ON app_user.id = account.user_id
     WHERE app_user.email = $1 AND account.password IS NOT NULL
     LIMIT 1`,
    [email],
  );
  assert.ok(
    accountPassword.rows[0]?.password,
    'The password hash should be stored in the account record.',
  );
  assert.notEqual(
    accountPassword.rows[0].password,
    password,
    'Passwords must never be stored in plaintext.',
  );

  const invalidLogin = await authRequest('sign-in/email', {
    email,
    password: 'incorrect-password',
  });
  assert.equal(invalidLogin.ok, false, 'Invalid credentials must be rejected.');

  const verificationEmailCountBeforeSignIn = emailMessages.filter(
    (message) =>
      message.recipient === email && decodeQuotedPrintable(message.raw).includes('/verify-email?'),
  ).length;
  const unverifiedLogin = await authRequest('sign-in/email', {
    email,
    password,
    callbackURL: '/login?verified=1',
  });
  assert.equal(
    unverifiedLogin.ok,
    false,
    'Correct credentials must not bypass email verification.',
  );
  const unverifiedLoginBody = await unverifiedLogin.json();
  assert.equal(unverifiedLoginBody.code, 'EMAIL_NOT_VERIFIED');
  const unverifiedAccountBeforeVerification = await pool.query(
    'SELECT email_verified FROM commitmentos."user" WHERE id = $1',
    [registrationResult.user.id],
  );
  assert.equal(unverifiedAccountBeforeVerification.rows[0]?.email_verified, false);
  const successfulVerification = await followVerificationLink(email, {
    afterDeliveryCount: verificationEmailCountBeforeSignIn,
  });
  const initialVerificationToken = new URL(initialVerificationLink).searchParams.get('token');
  assert.ok(initialVerificationToken);
  await assertVerificationReplayRejected(successfulVerification.link);

  // If two tokens were issued in the same second, Better Auth can sign identical JWTs.
  // Otherwise, prove that the earlier still-valid token can only be redeemed once.
  if (successfulVerification.token !== initialVerificationToken) {
    const previouslyIssuedLinkResponse = await fetch(initialVerificationLink, {
      redirect: 'manual',
    });
    assert.equal(previouslyIssuedLinkResponse.status, 302);
    verificationTokenHashes.push(
      createHash('sha256').update(initialVerificationToken).digest('hex'),
    );
    await assertVerificationReplayRejected(initialVerificationLink);
  }

  const verifiedAccount = await pool.query(
    'SELECT email_verified FROM commitmentos."user" WHERE id = $1',
    [registrationResult.user.id],
  );
  assert.equal(verifiedAccount.rows[0]?.email_verified, true);

  const login = await authRequest('sign-in/email', { email, password });
  assert.ok(login.ok, 'A user who followed the delivered verification link should sign in.');
  const setCookieHeaders = login.headers.getSetCookie();
  const sessionSetCookie = setCookieHeaders.find((value) => value.includes('session_token'));
  assert.ok(sessionSetCookie, 'Sign-in should set an HTTP session cookie.');
  assert.match(sessionSetCookie, /;\s*httponly(?:;|$)/i);
  assert.match(sessionSetCookie, /;\s*secure(?:;|$)/i);
  assert.match(sessionSetCookie, /;\s*samesite=lax(?:;|$)/i);
  const cookie = readCookieHeader(login);
  assert.ok(
    cookie.includes('session_token'),
    'The session cookie must be available to the HTTP client.',
  );
  const selfVerificationAttempt = await authRequest('update-user', { emailVerified: true }, cookie);
  assert.equal(
    selfVerificationAttempt.ok,
    false,
    'Authenticated users must not be able to mark their own email address as verified.',
  );
  const selfVerifiedAccount = await pool.query(
    'SELECT email_verified FROM commitmentos."user" WHERE id = $1',
    [registrationResult.user.id],
  );
  assert.equal(selfVerifiedAccount.rows[0]?.email_verified, true);

  const authenticatedPage = await fetch(`${baseURL}/app`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(
    authenticatedPage.status,
    200,
    'An authenticated user should be able to access /app.',
  );
  assert.equal(authenticatedPage.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(authenticatedPage.headers.get('x-frame-options'), 'DENY');
  assert.equal(authenticatedPage.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(
    authenticatedPage.headers.get('permissions-policy'),
    'camera=(), microphone=(), geolocation=()',
  );
  assert.match(
    authenticatedPage.headers.get('strict-transport-security') ?? '',
    /max-age=31536000/,
  );
  const initialAppBody = await authenticatedPage.text();
  assert.match(initialAppBody, new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(initialAppBody, /No workspace available/);
  assert.match(initialAppBody, /Sign out/);
  for (const sectionName of ['Inbox', 'Commitments', 'Dashboard', 'Integrations', 'Settings']) {
    assert.match(initialAppBody, new RegExp(sectionName));
  }
  assert.match(authenticatedPage.headers.get('cache-control') ?? '', /private/i);
  assert.match(authenticatedPage.headers.get('cache-control') ?? '', /no-store/i);

  const anonymousWorkspaceList = await workspaceRequest('/api/workspaces');
  assert.equal(anonymousWorkspaceList.status, 401, 'Workspace APIs must require authentication.');
  const anonymousWorkspaceCreate = await workspaceRequest('/api/workspaces', {
    method: 'POST',
    body: { name: 'Unauthenticated workspace' },
  });
  assert.equal(anonymousWorkspaceCreate.status, 401);

  const blankWorkspaceName = await workspaceRequest('/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: '   ' },
  });
  assert.equal(blankWorkspaceName.status, 400, 'Blank workspace names must be rejected.');

  const attemptedOwnerOverride = await workspaceRequest('/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: 'Overposted workspace', userId: registrationResult.user.id, role: 'OWNER' },
  });
  assert.equal(attemptedOwnerOverride.status, 400, 'Clients must not choose workspace ownership.');

  const firstWorkspaceResponse = await workspaceRequest('/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: '  Product Team  ' },
  });
  assert.equal(firstWorkspaceResponse.status, 201, 'Authenticated users should create workspaces.');
  const firstWorkspaceResult = await firstWorkspaceResponse.json();
  const firstWorkspace = firstWorkspaceResult.workspace;
  workspaceIds.push(firstWorkspace.id);
  assert.equal(firstWorkspace.name, 'Product Team', 'Workspace names should be trimmed.');
  assert.equal(firstWorkspace.role, 'OWNER', 'Workspace creators must become owners.');
  const workspaceCreatedEvents = await pool.query(
    `SELECT id, actor_user_id, target_user_id, event_type, details
     FROM commitmentos.workspace_audit_event
     WHERE workspace_id = $1`,
    [firstWorkspace.id],
  );
  assert.equal(workspaceCreatedEvents.rows.length, 1);
  const workspaceCreatedEvent = workspaceCreatedEvents.rows[0];
  assert.equal(workspaceCreatedEvent.actor_user_id, registrationResult.user.id);
  assert.equal(workspaceCreatedEvent.target_user_id, registrationResult.user.id);
  assert.equal(workspaceCreatedEvent.event_type, 'WORKSPACE_CREATED');
  assert.deepEqual(workspaceCreatedEvent.details, { role: 'OWNER' });
  await assertDatabaseRejects(
    'DELETE FROM commitmentos.workspace WHERE id = $1',
    [firstWorkspace.id],
    '23503',
    'A workspace with immutable administration history must not be deleted.',
  );
  await assertDatabaseRejects(
    'DELETE FROM commitmentos."user" WHERE id = $1',
    [registrationResult.user.id],
    '23503',
    'Users referenced by immutable workspace history must not be deleted.',
  );
  await assertDatabaseRejects(
    `UPDATE commitmentos.workspace_audit_event
     SET details = details || '{"tampered": true}'::jsonb WHERE id = $1`,
    [workspaceCreatedEvent.id],
    '55000',
    'Workspace audit events must reject updates.',
  );
  await assertDatabaseRejects(
    'DELETE FROM commitmentos.workspace_audit_event WHERE id = $1',
    [workspaceCreatedEvent.id],
    '55000',
    'Workspace audit events must reject deletes.',
  );
  const workspaceAuditTruncateClient = await pool.connect();
  try {
    await workspaceAuditTruncateClient.query('BEGIN');
    await assert.rejects(
      workspaceAuditTruncateClient.query('TRUNCATE TABLE commitmentos.workspace_audit_event'),
      (error) => error.code === '55000',
      'Workspace audit events must reject truncation.',
    );
  } finally {
    await workspaceAuditTruncateClient.query('ROLLBACK');
    workspaceAuditTruncateClient.release();
  }

  const authenticatedWorkspacePage = await appPageRequest(
    `/app?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(authenticatedWorkspacePage.status, 200);
  const authenticatedWorkspaceBody = await authenticatedWorkspacePage.text();
  assert.match(authenticatedWorkspaceBody, /Product Team/);
  assert.match(authenticatedWorkspaceBody, /Active workspace/);
  assert.match(authenticatedWorkspaceBody, /Workspace owner/);
  assert.match(authenticatedWorkspaceBody, /Your overview is ready/);
  assert.match(authenticatedWorkspacePage.headers.get('cache-control') ?? '', /no-store/i);

  const ownerMembership = await pool.query(
    `SELECT role
     FROM commitmentos.workspace_member
     WHERE workspace_id = $1 AND user_id = $2`,
    [firstWorkspace.id, registrationResult.user.id],
  );
  assert.equal(ownerMembership.rows[0]?.role, 'OWNER');

  await assert.rejects(
    pool.query(
      `INSERT INTO commitmentos.workspace_member (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), firstWorkspace.id, registrationResult.user.id, 'OWNER'],
    ),
    (error) => error.code === '23505',
    'The database must prevent duplicate user/workspace memberships.',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO commitmentos.workspace_member (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), randomUUID(), registrationResult.user.id, 'MEMBER'],
    ),
    (error) => error.code === '23503',
    'Membership rows must reference an existing workspace.',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO commitmentos.workspace_member (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), firstWorkspace.id, randomUUID(), 'MEMBER'],
    ),
    (error) => error.code === '23503',
    'Membership rows must reference an existing user.',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO commitmentos.workspace_member (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), firstWorkspace.id, registrationResult.user.id, 'ADMIN'],
    ),
    (error) => error.code === '22P02',
    'The database must reject roles outside OWNER and MEMBER.',
  );

  const anonymousWorkspaceDetails = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}`);
  assert.equal(anonymousWorkspaceDetails.status, 401);

  const firstWorkspaceListResponse = await workspaceRequest('/api/workspaces', { cookie });
  assert.equal(firstWorkspaceListResponse.status, 200);
  const firstWorkspaceList = await firstWorkspaceListResponse.json();
  assert.deepEqual(
    firstWorkspaceList.workspaces.map((item) => item.id),
    [firstWorkspace.id],
    'Users should list only workspaces where they are members.',
  );

  const firstWorkspaceDetails = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}`, {
    cookie,
  });
  assert.equal(firstWorkspaceDetails.status, 200);
  const firstWorkspaceDetailsResult = await firstWorkspaceDetails.json();
  assert.equal(firstWorkspaceDetailsResult.workspace.id, firstWorkspace.id);
  assert.equal(firstWorkspaceDetailsResult.workspace.role, 'OWNER');

  const invalidWorkspaceDetails = await workspaceRequest(
    '/api/workspaces/not-a-valid-workspace-id',
    { cookie },
  );
  assert.equal(invalidWorkspaceDetails.status, 404, 'Unknown workspace IDs must remain hidden.');

  const secondWorkspaceResponse = await workspaceRequest('/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: 'Operations' },
  });
  assert.equal(secondWorkspaceResponse.status, 201);
  const secondWorkspace = (await secondWorkspaceResponse.json()).workspace;
  workspaceIds.push(secondWorkspace.id);
  assert.equal(secondWorkspace.role, 'OWNER');

  const appSectionCases = [
    ['/app', 'Your overview is ready'],
    ['/app/inbox', 'No commitments yet.'],
    ['/app/commitments', 'No commitments to show yet'],
    ['/app/integrations', 'No integrations are configured here'],
    ['/app/settings', 'Your signed-in profile'],
  ];
  for (const [path, expectedContent] of appSectionCases) {
    const response = await appPageRequest(`${path}?workspaceId=${secondWorkspace.id}`, cookie);
    assert.equal(response.status, 200, `${path} should render for a workspace member.`);
    const body = await response.text();
    assert.match(body, /Operations/);
    assert.ok(body.includes(expectedContent), `${path} should render its designed empty state.`);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  }
  const workspaceSwitchNotice = await appPageRequest(
    `/app?workspaceId=${secondWorkspace.id}&notice=workspace-switched`,
    cookie,
  );
  assert.equal(workspaceSwitchNotice.status, 200);
  assert.match(await workspaceSwitchNotice.text(), /Switched to Operations/);

  const secondRegistration = await authRequest('sign-up/email', {
    name: 'Second Integration User',
    email: secondEmail,
    password,
    callbackURL: '/login?verified=1',
  });
  assert.ok(secondRegistration.ok, 'A second user should register for isolation checks.');
  const secondRegistrationResult = await secondRegistration.json();
  assert.equal(secondRegistrationResult.user.email, secondEmail);
  assert.equal(secondRegistrationResult.user.emailVerified, false);

  const unverifiedMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members`,
    {
      method: 'POST',
      cookie,
      body: { email: secondEmail },
    },
  );
  assert.equal(
    unverifiedMemberResponse.status,
    404,
    'An unverified email address must not be added to a workspace.',
  );
  const secondUnverifiedAccount = await pool.query(
    'SELECT email_verified FROM commitmentos."user" WHERE id = $1',
    [secondRegistrationResult.user.id],
  );
  assert.equal(secondUnverifiedAccount.rows[0]?.email_verified, false);

  const expiredVerificationToken = await createEmailVerificationToken(
    authSecret,
    secondEmail,
    undefined,
    -1,
  );
  const expiredVerificationUrl = new URL('/api/auth/verify-email', baseURL);
  expiredVerificationUrl.searchParams.set('token', expiredVerificationToken);
  expiredVerificationUrl.searchParams.set('callbackURL', '/login?verified=1');
  const expiredVerificationResponse = await fetch(expiredVerificationUrl, { redirect: 'manual' });
  assert.equal(expiredVerificationResponse.status, 302);
  const expiredVerificationCallback = new URL(
    expiredVerificationResponse.headers.get('location') ?? '',
    baseURL,
  );
  assert.equal(expiredVerificationCallback.searchParams.get('error'), 'TOKEN_EXPIRED');
  const expiredVerificationMarker = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM commitmentos.email_verification_token_use
     WHERE token_hash = $1`,
    [createHash('sha256').update(expiredVerificationToken).digest('hex')],
  );
  assert.equal(expiredVerificationMarker.rows[0].count, 0);
  const secondAccountStillUnverified = await pool.query(
    'SELECT email_verified FROM commitmentos."user" WHERE id = $1',
    [secondRegistrationResult.user.id],
  );
  assert.equal(secondAccountStillUnverified.rows[0]?.email_verified, false);

  await followVerificationLink(secondEmail, { concurrent: true });
  const secondVerifiedAccount = await pool.query(
    'SELECT email_verified FROM commitmentos."user" WHERE id = $1',
    [secondRegistrationResult.user.id],
  );
  assert.equal(secondVerifiedAccount.rows[0]?.email_verified, true);

  const secondLogin = await authRequest('sign-in/email', { email: secondEmail, password });
  assert.ok(secondLogin.ok, 'The verified second user should be able to sign in.');
  const secondCookie = readCookieHeader(secondLogin);

  const secondUserCannotSelectFirstWorkspace = await appPageRequest(
    `/app?workspaceId=${firstWorkspace.id}`,
    secondCookie,
  );
  await assertAppPageUnavailable(secondUserCannotSelectFirstWorkspace, ['Product Team']);
  const unknownWorkspaceSelection = await appPageRequest(
    `/app?workspaceId=${randomUUID()}`,
    cookie,
  );
  await assertAppPageUnavailable(unknownWorkspaceSelection);
  const ambiguousWorkspaceSelection = await appPageRequest(
    `/app?workspaceId=${firstWorkspace.id}&workspaceId=${secondWorkspace.id}`,
    cookie,
  );
  await assertAppPageUnavailable(ambiguousWorkspaceSelection);

  const persistenceCommitments = await testCommitmentPersistence({
    workspaceId: firstWorkspace.id,
    otherWorkspaceId: secondWorkspace.id,
    userId: registrationResult.user.id,
  });

  const firstWorkspaceDashboard = await appPageRequest(
    `/app?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(firstWorkspaceDashboard.status, 200);
  const firstWorkspaceDashboardBody = await firstWorkspaceDashboard.text();
  assert.match(firstWorkspaceDashboardBody, /<dt>Active commitments<\/dt>\s*<dd>1<\/dd>/);
  assert.match(firstWorkspaceDashboardBody, /<dt>Needs an owner<\/dt>\s*<dd>0<\/dd>/);
  assert.match(firstWorkspaceDashboardBody, /<span aria-label="Open: 1">1<\/span>/);
  assert.doesNotMatch(firstWorkspaceDashboardBody, /Follow up|provider-message-123/);
  assert.ok(!firstWorkspaceDashboardBody.includes('customer@example.test'));
  assert.match(firstWorkspaceDashboard.headers.get('cache-control') ?? '', /no-store/i);

  const secondWorkspaceDashboard = await appPageRequest(
    `/app?workspaceId=${secondWorkspace.id}`,
    cookie,
  );
  assert.equal(secondWorkspaceDashboard.status, 200);
  const secondWorkspaceDashboardBody = await secondWorkspaceDashboard.text();
  assert.match(secondWorkspaceDashboardBody, /<dt>Active commitments<\/dt>\s*<dd>1<\/dd>/);
  assert.match(secondWorkspaceDashboardBody, /<dt>Needs an owner<\/dt>\s*<dd>1<\/dd>/);
  assert.match(secondWorkspaceDashboardBody, /<span aria-label="Detected: 1">1<\/span>/);
  assert.doesNotMatch(secondWorkspaceDashboardBody, /Send the revised proposal/);

  const firstWorkspaceInbox = await appPageRequest(
    `/app/inbox?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(firstWorkspaceInbox.status, 200);
  const firstWorkspaceInboxBody = await firstWorkspaceInbox.text();
  assert.match(firstWorkspaceInboxBody, /Send the revised proposal/);
  assert.ok(firstWorkspaceInboxBody.includes('I will send the revised proposal.'));
  assert.match(firstWorkspaceInboxBody, /Assigned/);
  assert.match(firstWorkspaceInboxBody, /Customer Example/);
  assert.match(firstWorkspaceInboxBody, /02 Nov 2026, 10:30/);
  assert.doesNotMatch(firstWorkspaceInboxBody, /I will send the revised proposal by Monday/);
  assert.doesNotMatch(firstWorkspaceInboxBody, /provider-message-123/);
  assert.ok(!firstWorkspaceInboxBody.includes('customer@example.test'));
  assert.match(firstWorkspaceInbox.headers.get('cache-control') ?? '', /no-store/i);

  const secondWorkspaceInbox = await appPageRequest(
    `/app/inbox?workspaceId=${secondWorkspace.id}`,
    cookie,
  );
  assert.equal(secondWorkspaceInbox.status, 200);
  const secondWorkspaceInboxBody = await secondWorkspaceInbox.text();
  assert.match(secondWorkspaceInboxBody, /Follow up/);
  assert.ok(secondWorkspaceInboxBody.includes('I will follow up.'));
  assert.match(secondWorkspaceInboxBody, /Unassigned/);
  assert.match(secondWorkspaceInboxBody, /No deadline set/);
  assert.doesNotMatch(secondWorkspaceInboxBody, /Send the revised proposal/);
  assert.match(secondWorkspaceInbox.headers.get('cache-control') ?? '', /no-store/i);
  assert.ok(
    firstWorkspaceInboxBody.includes(
      `/app/commitments/${persistenceCommitments.populatedId}?workspaceId=${firstWorkspace.id}`,
    ),
    'Inbox records should link to their workspace-scoped detail page.',
  );

  const authorizedCommitmentDetail = await appPageRequest(
    `/app/commitments/${persistenceCommitments.populatedId}?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(authorizedCommitmentDetail.status, 200);
  const authorizedCommitmentDetailBody = await authorizedCommitmentDetail.text();
  assert.match(authorizedCommitmentDetailBody, /Send the revised proposal/);
  assert.ok(authorizedCommitmentDetailBody.includes('I will send the revised proposal.'));
  assert.match(authorizedCommitmentDetailBody, /Open/);
  assert.match(authorizedCommitmentDetailBody, /Customer Example/);
  assert.doesNotMatch(authorizedCommitmentDetailBody, /I will send the revised proposal by Monday/);
  assert.doesNotMatch(authorizedCommitmentDetailBody, /provider-message-123/);
  assert.ok(!authorizedCommitmentDetailBody.includes('customer@example.test'));
  assert.ok(
    authorizedCommitmentDetailBody.includes(
      `aria-current="page" class="app-nav-link app-nav-link-active" href="/app/commitments?workspaceId=${firstWorkspace.id}"`,
    ),
  );
  assert.match(authorizedCommitmentDetail.headers.get('cache-control') ?? '', /no-store/i);

  const crossWorkspaceCommitmentDetail = await appPageRequest(
    `/app/commitments/${persistenceCommitments.populatedId}?workspaceId=${secondWorkspace.id}`,
    cookie,
  );
  await assertAppPageUnavailable(crossWorkspaceCommitmentDetail, [
    'I will send the revised proposal.',
  ]);
  const nonMemberCommitmentDetail = await appPageRequest(
    `/app/commitments/${persistenceCommitments.populatedId}?workspaceId=${firstWorkspace.id}`,
    secondCookie,
  );
  await assertAppPageUnavailable(nonMemberCommitmentDetail, [
    'Product Team',
    'I will send the revised proposal.',
  ]);
  const unknownCommitmentDetail = await appPageRequest(
    `/app/commitments/${randomUUID()}?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  await assertAppPageUnavailable(unknownCommitmentDetail);

  const firstCommitmentsPath = `/api/workspaces/${firstWorkspace.id}/commitments`;
  const apiCommitmentCollectionAnonymous = await workspaceRequest(firstCommitmentsPath);
  assert.equal(apiCommitmentCollectionAnonymous.status, 401);
  const apiCommitmentItemAnonymous = await workspaceRequest(
    `${firstCommitmentsPath}/${persistenceCommitments.populatedId}`,
  );
  assert.equal(apiCommitmentItemAnonymous.status, 401);
  const apiCommitmentAuditAnonymous = await workspaceRequest(
    `${firstCommitmentsPath}/${persistenceCommitments.populatedId}/audit-events`,
  );
  assert.equal(apiCommitmentAuditAnonymous.status, 401);

  const secondUserCannotListCommitmentsBeforeMembership = await workspaceRequest(
    firstCommitmentsPath,
    { cookie: secondCookie },
  );
  assert.equal(secondUserCannotListCommitmentsBeforeMembership.status, 404);
  const secondUserCannotCreateCommitmentBeforeMembership = await workspaceRequest(
    firstCommitmentsPath,
    {
      method: 'POST',
      cookie: secondCookie,
      body: { commitmentText: 'Unauthorized', normalizedAction: 'Create unauthorized item' },
    },
  );
  assert.equal(secondUserCannotCreateCommitmentBeforeMembership.status, 404);

  const overpostedCommitment = await workspaceRequest(firstCommitmentsPath, {
    method: 'POST',
    cookie,
    body: {
      commitmentText: 'Must not be created',
      normalizedAction: 'Attempt client-owned fields',
      workspaceId: secondWorkspace.id,
      createdBy: secondRegistrationResult.user.id,
      status: 'OPEN',
    },
  });
  assert.equal(overpostedCommitment.status, 400, 'Creation must reject server-owned fields.');

  const apiCommitmentCreate = await workspaceRequest(firstCommitmentsPath, {
    method: 'POST',
    cookie,
    body: {
      commitmentText: 'Send the API integration report.',
      normalizedAction: 'Send integration report',
      ownerUserId: null,
      dueAt: null,
      completionEvidence: 'Must not be accepted at creation.',
    },
  });
  assert.equal(apiCommitmentCreate.status, 400, 'Creation must reject lifecycle-only fields.');
  const oversizedCommitmentCreate = await workspaceRequest(firstCommitmentsPath, {
    method: 'POST',
    cookie,
    body: {
      commitmentText: 'x'.repeat(300_000),
      normalizedAction: 'Send oversized request',
    },
  });
  assert.equal(oversizedCommitmentCreate.status, 413);
  assert.equal((await oversizedCommitmentCreate.json()).error, 'PAYLOAD_TOO_LARGE');

  const validApiCommitmentCreate = await workspaceRequest(firstCommitmentsPath, {
    method: 'POST',
    cookie,
    body: {
      commitmentText: 'Send the API integration report.',
      normalizedAction: 'Send integration report',
      ownerUserId: null,
      dueAt: null,
    },
  });
  assert.equal(validApiCommitmentCreate.status, 201);
  const apiCommitment = (await validApiCommitmentCreate.json()).commitment;
  assert.equal(apiCommitment.workspaceId, firstWorkspace.id);
  assert.equal(apiCommitment.createdBy, registrationResult.user.id);
  assert.equal(apiCommitment.status, 'DETECTED', 'API-created commitments start in DETECTED.');
  assert.equal(apiCommitment.completionEvidence, null);
  assert.equal(apiCommitment.completedAt, null);

  const dashboardAfterApiCreate = await appPageRequest(
    `/app?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(dashboardAfterApiCreate.status, 200);
  const dashboardAfterApiCreateBody = await dashboardAfterApiCreate.text();
  assert.match(dashboardAfterApiCreateBody, /<dt>Active commitments<\/dt>\s*<dd>2<\/dd>/);
  assert.match(dashboardAfterApiCreateBody, /<dt>Needs an owner<\/dt>\s*<dd>1<\/dd>/);
  assert.match(dashboardAfterApiCreateBody, /<span aria-label="Detected: 1">1<\/span>/);
  assert.match(dashboardAfterApiCreateBody, /<span aria-label="Open: 1">1<\/span>/);
  assert.doesNotMatch(dashboardAfterApiCreateBody, /provider-message-123/);
  assert.ok(!dashboardAfterApiCreateBody.includes('customer@example.test'));

  const createdAuditResult = await pool.query(
    `SELECT workspace_id, commitment_id, actor_user_id, event_type, details, occurred_at
     FROM commitmentos.commitment_audit_event
     WHERE commitment_id = $1`,
    [apiCommitment.id],
  );
  assert.equal(createdAuditResult.rows.length, 1, 'Creation must be audited atomically.');
  assert.equal(createdAuditResult.rows[0].workspace_id, firstWorkspace.id);
  assert.equal(createdAuditResult.rows[0].commitment_id, apiCommitment.id);
  assert.equal(createdAuditResult.rows[0].actor_user_id, registrationResult.user.id);
  assert.equal(createdAuditResult.rows[0].event_type, 'CREATED');
  assert.equal(createdAuditResult.rows[0].details.initialStatus, 'DETECTED');
  assert.ok(createdAuditResult.rows[0].occurred_at instanceof Date);

  await assertDatabaseRejects(
    `INSERT INTO commitmentos.commitment_audit_event (
       id, workspace_id, commitment_id, actor_user_id, event_type, details
     ) VALUES ($1, $2, $3, $4, 'EDITED', '{}'::jsonb)`,
    [randomUUID(), firstWorkspace.id, persistenceCommitments.sparseId, registrationResult.user.id],
    '23503',
    'Audit rows must not associate a workspace with another workspace commitment.',
  );

  const firstWorkspaceCommitmentListResponse = await workspaceRequest(firstCommitmentsPath, {
    cookie,
  });
  assert.equal(firstWorkspaceCommitmentListResponse.status, 200);
  const firstWorkspaceCommitments = (await firstWorkspaceCommitmentListResponse.json()).commitments;
  assert.deepEqual(
    new Set(firstWorkspaceCommitments.map((item) => item.id)),
    new Set([persistenceCommitments.populatedId, apiCommitment.id]),
    'A collection response must include only commitments in the authorized workspace.',
  );
  const secondWorkspaceCommitmentListResponse = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/commitments`,
    { cookie },
  );
  assert.equal(secondWorkspaceCommitmentListResponse.status, 200);
  assert.deepEqual(
    (await secondWorkspaceCommitmentListResponse.json()).commitments.map((item) => item.id),
    [persistenceCommitments.sparseId],
    'A second workspace list must not include the first workspace commitments.',
  );

  const apiCommitmentItemResponse = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    { cookie },
  );
  assert.equal(apiCommitmentItemResponse.status, 200);
  assert.equal((await apiCommitmentItemResponse.json()).commitment.id, apiCommitment.id);

  const crossWorkspaceCommitmentRead = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/commitments/${apiCommitment.id}`,
    { cookie },
  );
  assert.equal(crossWorkspaceCommitmentRead.status, 404);
  const crossWorkspaceCommitmentUpdate = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/commitments/${apiCommitment.id}`,
    { method: 'PATCH', cookie, body: { commitmentText: 'Cross-workspace update' } },
  );
  assert.equal(crossWorkspaceCommitmentUpdate.status, 404);
  const crossWorkspaceAuditRead = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/commitments/${apiCommitment.id}/audit-events`,
    { cookie },
  );
  assert.equal(crossWorkspaceAuditRead.status, 404);
  const nonMemberAuditRead = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}/audit-events`,
    { cookie: secondCookie },
  );
  assert.equal(nonMemberAuditRead.status, 404);

  const secondUserCannotReadCommitmentBeforeMembership = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    { cookie: secondCookie },
  );
  assert.equal(secondUserCannotReadCommitmentBeforeMembership.status, 404);

  const nonMemberOwnerAssignment = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    { method: 'PATCH', cookie, body: { ownerUserId: secondRegistrationResult.user.id } },
  );
  assert.equal(
    nonMemberOwnerAssignment.status,
    400,
    'Commitment owners must be workspace members.',
  );

  const emptySecondUserList = await workspaceRequest('/api/workspaces', { cookie: secondCookie });
  assert.equal(emptySecondUserList.status, 200);
  assert.deepEqual((await emptySecondUserList.json()).workspaces, []);

  const failedMembershipAuditSuffix = randomUUID().replaceAll('-', '');
  const rejectMembershipAuditFunction = `integration_reject_workspace_audit_${failedMembershipAuditSuffix}`;
  const rejectMembershipAuditTrigger = `integration_reject_workspace_audit_${failedMembershipAuditSuffix}`;
  try {
    await pool.query(`
      CREATE FUNCTION commitmentos."${rejectMembershipAuditFunction}"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $audit$
      BEGIN
        IF NEW.event_type = 'MEMBER_ADDED' THEN
          RAISE EXCEPTION 'simulated workspace audit persistence failure' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $audit$
    `);
    await pool.query(`
      CREATE TRIGGER "${rejectMembershipAuditTrigger}"
      BEFORE INSERT ON commitmentos.workspace_audit_event
      FOR EACH ROW EXECUTE FUNCTION commitmentos."${rejectMembershipAuditFunction}"()
    `);

    const failedMemberAdd = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}/members`, {
      method: 'POST',
      cookie,
      body: { email: secondEmail },
    });
    assert.equal(failedMemberAdd.status, 500);
    const rolledBackMembership = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM commitmentos.workspace_member
       WHERE workspace_id = $1 AND user_id = $2`,
      [firstWorkspace.id, secondRegistrationResult.user.id],
    );
    assert.equal(rolledBackMembership.rows[0].count, 0);
  } finally {
    await pool.query(
      `DROP TRIGGER IF EXISTS "${rejectMembershipAuditTrigger}" ON commitmentos.workspace_audit_event`,
    );
    await pool.query(`DROP FUNCTION IF EXISTS commitmentos."${rejectMembershipAuditFunction}"()`);
  }

  const addMemberResponse = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}/members`, {
    method: 'POST',
    cookie,
    body: { email: secondEmail },
  });
  assert.equal(addMemberResponse.status, 201, 'Owners should be able to add registered users.');
  const addedMember = (await addMemberResponse.json()).member;
  assert.equal(addedMember.userId, secondRegistrationResult.user.id);
  assert.equal(addedMember.role, 'MEMBER');
  const memberAddedEvents = await pool.query(
    `SELECT actor_user_id, target_user_id, event_type, details
     FROM commitmentos.workspace_audit_event
     WHERE workspace_id = $1 AND event_type = 'MEMBER_ADDED'`,
    [firstWorkspace.id],
  );
  assert.deepEqual(memberAddedEvents.rows, [
    {
      actor_user_id: registrationResult.user.id,
      target_user_id: secondRegistrationResult.user.id,
      event_type: 'MEMBER_ADDED',
      details: { role: 'MEMBER' },
    },
  ]);

  const newlyAddedMemberWorkspacePage = await appPageRequest(
    `/app/settings?workspaceId=${firstWorkspace.id}`,
    secondCookie,
  );
  assert.equal(newlyAddedMemberWorkspacePage.status, 200);
  assert.match(await newlyAddedMemberWorkspacePage.text(), /Product Team/);

  const memberCommitmentList = await workspaceRequest(firstCommitmentsPath, {
    cookie: secondCookie,
  });
  assert.equal(memberCommitmentList.status, 200, 'Workspace members may list commitments.');
  assert.ok(
    (await memberCommitmentList.json()).commitments.some((item) => item.id === apiCommitment.id),
  );

  const assignCommitmentOwner = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    {
      method: 'PATCH',
      cookie: secondCookie,
      body: { ownerUserId: secondRegistrationResult.user.id },
    },
  );
  assert.equal(assignCommitmentOwner.status, 200);
  assert.equal(
    (await assignCommitmentOwner.json()).commitment.ownerUserId,
    secondRegistrationResult.user.id,
  );
  const assignedOwnerDetail = await appPageRequest(
    `/app/commitments/${apiCommitment.id}?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(assignedOwnerDetail.status, 200);
  const assignedOwnerDetailBody = await assignedOwnerDetail.text();
  assert.match(assignedOwnerDetailBody, /Second Integration User/);
  assert.ok(!assignedOwnerDetailBody.includes(secondEmail));

  const invalidCommitmentOwner = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    { method: 'PATCH', cookie, body: { ownerUserId: randomUUID() } },
  );
  assert.equal(invalidCommitmentOwner.status, 400);

  const editAndDeadlineChange = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    {
      method: 'PATCH',
      cookie,
      body: {
        commitmentText: 'Send the revised integration report.',
        sourceExcerpt: 'Private source excerpt; do not duplicate into audit metadata.',
        dueAt: '2026-11-02T09:30:00.000Z',
        dueTimezone: 'Europe/Brussels',
      },
    },
  );
  assert.equal(editAndDeadlineChange.status, 200);
  const editedCommitment = (await editAndDeadlineChange.json()).commitment;
  assert.equal(editedCommitment.commitmentText, 'Send the revised integration report.');
  assert.equal(editedCommitment.dueTimezone, 'Europe/Brussels');

  const openCommitment = await workspaceRequest(`${firstCommitmentsPath}/${apiCommitment.id}`, {
    method: 'PATCH',
    cookie: secondCookie,
    body: { status: 'OPEN' },
  });
  assert.equal(openCommitment.status, 200);
  assert.equal((await openCommitment.json()).commitment.status, 'OPEN');

  const updateCommitmentStatus = (status) =>
    workspaceRequest(`${firstCommitmentsPath}/${apiCommitment.id}`, {
      method: 'PATCH',
      cookie,
      body: { status },
    });

  const repeatedCommitmentStatus = await updateCommitmentStatus('OPEN');
  assert.equal(repeatedCommitmentStatus.status, 409);
  assert.equal((await repeatedCommitmentStatus.json()).error, 'INVALID_TRANSITION');

  const dueSoonCommitment = await updateCommitmentStatus('DUE_SOON');
  assert.equal(dueSoonCommitment.status, 200);
  const dueSoonCannotReopen = await updateCommitmentStatus('OPEN');
  assert.equal(dueSoonCannotReopen.status, 409);
  assert.equal((await dueSoonCannotReopen.json()).error, 'INVALID_TRANSITION');

  const waitingCommitment = await updateCommitmentStatus('WAITING');
  assert.equal(waitingCommitment.status, 200);
  const waitingCannotBecomeBlocked = await updateCommitmentStatus('BLOCKED');
  assert.equal(waitingCannotBecomeBlocked.status, 409);
  assert.equal((await waitingCannotBecomeBlocked.json()).error, 'INVALID_TRANSITION');

  const reopenedWaitingCommitment = await updateCommitmentStatus('OPEN');
  assert.equal(reopenedWaitingCommitment.status, 200);
  const blockedCommitment = await updateCommitmentStatus('BLOCKED');
  assert.equal(blockedCommitment.status, 200);
  const blockedCannotBecomeWaiting = await updateCommitmentStatus('WAITING');
  assert.equal(blockedCannotBecomeWaiting.status, 409);
  assert.equal((await blockedCannotBecomeWaiting.json()).error, 'INVALID_TRANSITION');

  const overdueCommitment = await updateCommitmentStatus('OVERDUE');
  assert.equal(overdueCommitment.status, 200);
  for (const forbiddenOverdueTarget of ['OPEN', 'DUE_SOON', 'WAITING', 'BLOCKED']) {
    const rejectedTransition = await updateCommitmentStatus(forbiddenOverdueTarget);
    assert.equal(rejectedTransition.status, 409);
    assert.equal(
      (await rejectedTransition.json()).error,
      'INVALID_TRANSITION',
      `OVERDUE -> ${forbiddenOverdueTarget} must be rejected by the API.`,
    );
  }
  const stillOverdue = await workspaceRequest(`${firstCommitmentsPath}/${apiCommitment.id}`, {
    cookie,
  });
  assert.equal(stillOverdue.status, 200);
  assert.equal((await stillOverdue.json()).commitment.status, 'OVERDUE');

  const newEvidenceCannotReplaceAnExplicitSignal = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    {
      method: 'PATCH',
      cookie,
      body: { status: 'COMPLETED', completionEvidence: 'Evidence added in this same request.' },
    },
  );
  assert.equal(newEvidenceCannotReplaceAnExplicitSignal.status, 409);
  assert.equal(
    (await newEvidenceCannotReplaceAnExplicitSignal.json()).error,
    'COMPLETION_SIGNAL_REQUIRED',
  );

  const missingCompletionSignal = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    { method: 'PATCH', cookie, body: { status: 'COMPLETED' } },
  );
  assert.equal(missingCompletionSignal.status, 409);
  assert.equal((await missingCompletionSignal.json()).error, 'COMPLETION_SIGNAL_REQUIRED');

  const evidencePatch = await workspaceRequest(`${firstCommitmentsPath}/${apiCommitment.id}`, {
    method: 'PATCH',
    cookie,
    body: { completionEvidence: 'Counterparty confirmed delivery.' },
  });
  assert.equal(evidencePatch.status, 200);

  const completedCommitmentResponse = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    {
      method: 'PATCH',
      cookie: secondCookie,
      body: { status: 'COMPLETED' },
    },
  );
  assert.equal(completedCommitmentResponse.status, 200);
  const completedCommitment = (await completedCommitmentResponse.json()).commitment;
  assert.equal(completedCommitment.status, 'COMPLETED');
  assert.ok(completedCommitment.completedAt, 'The lifecycle service should timestamp completion.');
  assert.equal(completedCommitment.completionEvidence, 'Counterparty confirmed delivery.');

  const terminalCommitmentReopen = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    { method: 'PATCH', cookie, body: { status: 'OPEN' } },
  );
  assert.equal(terminalCommitmentReopen.status, 409);
  assert.equal((await terminalCommitmentReopen.json()).error, 'INVALID_TRANSITION');

  const auditEventsPath = `${firstCommitmentsPath}/${apiCommitment.id}/audit-events`;
  const invalidAuditEventLimit = await workspaceRequest(`${auditEventsPath}?limit=101`, { cookie });
  assert.equal(invalidAuditEventLimit.status, 400);
  const invalidAuditEventCursor = await workspaceRequest(`${auditEventsPath}?cursor=not-a-cursor`, {
    cookie,
  });
  assert.equal(invalidAuditEventCursor.status, 400);

  const auditEvents = [];
  let auditCursor = null;
  let firstAuditCursor = null;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const cursorQuery = auditCursor ? `&cursor=${encodeURIComponent(auditCursor)}` : '';
    const auditPageResponse = await workspaceRequest(`${auditEventsPath}?limit=3${cursorQuery}`, {
      cookie,
    });
    assert.equal(auditPageResponse.status, 200);
    const auditPage = await auditPageResponse.json();
    assert.ok(auditPage.events.length <= 3);
    auditEvents.push(...auditPage.events);
    auditCursor = auditPage.nextCursor;
    if (pageNumber === 0) firstAuditCursor = auditCursor;
    if (auditCursor === null) break;
  }
  assert.equal(new Set(auditEvents.map((event) => event.id)).size, auditEvents.length);
  assert.ok(auditEvents.length > 3, 'Audit history should be paginated without dropping events.');
  assert.ok(auditEvents.every((event) => event.workspaceId === firstWorkspace.id));
  assert.ok(auditEvents.every((event) => event.commitmentId === apiCommitment.id));
  assert.ok(
    auditEvents.every((event) =>
      [registrationResult.user.id, secondRegistrationResult.user.id].includes(event.actorUserId),
    ),
  );
  const auditEventTypes = new Set(auditEvents.map((event) => event.eventType));
  assert.equal(auditCursor, null, 'The audit cursor should reach the end of the history.');
  for (const requiredType of [
    'CREATED',
    'EDITED',
    'CONFIRMED',
    'REASSIGNED',
    'DEADLINE_CHANGED',
    'STATUS_CHANGED',
    'COMPLETION_EVIDENCE_RECORDED',
    'COMPLETED',
  ]) {
    assert.ok(auditEventTypes.has(requiredType), `Expected an audit record for ${requiredType}.`);
  }
  assert.ok(!auditEventTypes.has('DISMISSED'));
  const auditMetadata = JSON.stringify(auditEvents.map((event) => event.details));
  assert.ok(
    !auditMetadata.includes('Private source excerpt; do not duplicate into audit metadata.'),
  );
  assert.ok(!auditMetadata.includes('Counterparty confirmed delivery.'));
  assert.ok(!auditMetadata.includes('Send the revised integration report.'));

  const auditedCommitmentDetail = await appPageRequest(
    `/app/commitments/${apiCommitment.id}?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(auditedCommitmentDetail.status, 200);
  const auditedCommitmentDetailBody = await auditedCommitmentDetail.text();
  for (const eventLabel of [
    'Commitment created',
    'Owner assignment changed',
    'Deadline updated',
    'Commitment confirmed',
    'Completion evidence recorded',
    'Commitment completed',
  ]) {
    assert.ok(
      auditedCommitmentDetailBody.includes(eventLabel),
      `The commitment detail timeline should include ${eventLabel}.`,
    );
  }
  assert.ok(
    auditedCommitmentDetailBody.indexOf('Commitment completed') <
      auditedCommitmentDetailBody.indexOf('Commitment created'),
    'The detail timeline should order the newest audit event first.',
  );
  assert.doesNotMatch(auditedCommitmentDetailBody, /Private source excerpt/);
  assert.doesNotMatch(auditedCommitmentDetailBody, /Counterparty confirmed delivery/);
  assert.ok(!auditedCommitmentDetailBody.includes('customer@example.test'));
  assert.match(auditedCommitmentDetail.headers.get('cache-control') ?? '', /no-store/i);
  assert.ok(firstAuditCursor, 'The audit timeline pagination test needs an older-events cursor.');
  const olderAuditTimelinePage = await appPageRequest(
    `/app/commitments/${apiCommitment.id}?workspaceId=${firstWorkspace.id}&auditCursor=${encodeURIComponent(firstAuditCursor)}`,
    cookie,
  );
  assert.equal(olderAuditTimelinePage.status, 200);
  assert.match(await olderAuditTimelinePage.text(), /Commitment created/);
  const invalidAuditTimelineCursor = await appPageRequest(
    `/app/commitments/${apiCommitment.id}?workspaceId=${firstWorkspace.id}&auditCursor=not-a-cursor`,
    cookie,
  );
  await assertAppPageUnavailable(invalidAuditTimelineCursor);

  const immutableAuditEventId = auditEvents[0].id;
  await assert.rejects(
    pool.query(
      `UPDATE commitmentos.commitment_audit_event
       SET details = details || '{"tampered": true}'::jsonb WHERE id = $1`,
      [immutableAuditEventId],
    ),
    (error) => error.code === '55000',
    'Audit events must reject updates.',
  );
  await assert.rejects(
    pool.query('DELETE FROM commitmentos.commitment_audit_event WHERE id = $1', [
      immutableAuditEventId,
    ]),
    (error) => error.code === '55000',
    'Audit events must reject deletes.',
  );
  const truncateClient = await pool.connect();
  try {
    await truncateClient.query('BEGIN');
    await assert.rejects(
      truncateClient.query('TRUNCATE TABLE commitmentos.commitment_audit_event'),
      (error) => error.code === '55000',
      'Audit events must reject truncation.',
    );
  } finally {
    await truncateClient.query('ROLLBACK');
    truncateClient.release();
  }
  await assertDatabaseRejects(
    'DELETE FROM commitmentos.commitment WHERE id = $1',
    [apiCommitment.id],
    '23503',
    'Commitments with immutable audit history must not be deleted.',
  );
  await assertDatabaseRejects(
    'DELETE FROM commitmentos.workspace WHERE id = $1',
    [firstWorkspace.id],
    '23503',
    'Workspaces with immutable audit history must not be deleted.',
  );
  await assertDatabaseRejects(
    'DELETE FROM commitmentos."user" WHERE id = $1',
    [secondRegistrationResult.user.id],
    '23503',
    'Users attributed in immutable audit history must not be deleted.',
  );

  const rollbackCreateResponse = await workspaceRequest(firstCommitmentsPath, {
    method: 'POST',
    cookie,
    body: {
      commitmentText: 'Audit rollback check.',
      normalizedAction: 'Verify atomic audit writes',
    },
  });
  assert.equal(rollbackCreateResponse.status, 201);
  const rollbackCommitmentId = (await rollbackCreateResponse.json()).commitment.id;
  const triggerSuffix = randomUUID().replaceAll('-', '');
  const rejectAuditFunction = `integration_reject_audit_${triggerSuffix}`;
  const rejectAuditTrigger = `integration_reject_audit_${triggerSuffix}`;
  try {
    await pool.query(`
      CREATE FUNCTION commitmentos."${rejectAuditFunction}"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $audit$
      BEGIN
        IF NEW.event_type IN ('CREATED', 'EDITED') THEN
          RAISE EXCEPTION 'simulated audit persistence failure' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $audit$
    `);
    await pool.query(`
      CREATE TRIGGER "${rejectAuditTrigger}"
      BEFORE INSERT ON commitmentos.commitment_audit_event
      FOR EACH ROW EXECUTE FUNCTION commitmentos."${rejectAuditFunction}"()
    `);

    const failedAuditCreateText = 'Creation must roll back with the audit failure.';
    const failedAuditCreateResponse = await workspaceRequest(firstCommitmentsPath, {
      method: 'POST',
      cookie,
      body: { commitmentText: failedAuditCreateText, normalizedAction: 'Test create rollback' },
    });
    assert.equal(failedAuditCreateResponse.status, 500);
    const failedAuditCreateCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM commitmentos.commitment
       WHERE workspace_id = $1 AND created_by = $2 AND commitment_text = $3`,
      [firstWorkspace.id, registrationResult.user.id, failedAuditCreateText],
    );
    assert.equal(failedAuditCreateCount.rows[0].count, 0);

    const auditFailureResponse = await workspaceRequest(
      `${firstCommitmentsPath}/${rollbackCommitmentId}`,
      {
        method: 'PATCH',
        cookie,
        body: { commitmentText: 'This edit must roll back with the audit failure.' },
      },
    );
    assert.equal(auditFailureResponse.status, 500);
    const rolledBackCommitment = await pool.query(
      'SELECT commitment_text FROM commitmentos.commitment WHERE id = $1',
      [rollbackCommitmentId],
    );
    assert.equal(rolledBackCommitment.rows[0].commitment_text, 'Audit rollback check.');
    const rolledBackAuditEvents = await pool.query(
      `SELECT event_type FROM commitmentos.commitment_audit_event WHERE commitment_id = $1`,
      [rollbackCommitmentId],
    );
    assert.deepEqual(
      rolledBackAuditEvents.rows.map((event) => event.event_type),
      ['CREATED'],
    );
  } finally {
    await pool.query(
      `DROP TRIGGER IF EXISTS "${rejectAuditTrigger}" ON commitmentos.commitment_audit_event`,
    );
    await pool.query(`DROP FUNCTION IF EXISTS commitmentos."${rejectAuditFunction}"()`);
  }

  const raceCreateResponse = await workspaceRequest(firstCommitmentsPath, {
    method: 'POST',
    cookie,
    body: { commitmentText: 'Resolve concurrent transitions.', normalizedAction: 'Resolve race' },
  });
  assert.equal(raceCreateResponse.status, 201);
  const raceCommitmentId = (await raceCreateResponse.json()).commitment.id;
  const raceOpenResponse = await workspaceRequest(`${firstCommitmentsPath}/${raceCommitmentId}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'OPEN' },
  });
  assert.equal(raceOpenResponse.status, 200);
  const concurrentTransitions = await Promise.all([
    workspaceRequest(`${firstCommitmentsPath}/${raceCommitmentId}`, {
      method: 'PATCH',
      cookie,
      body: { status: 'COMPLETED', completionSignal: true },
    }),
    workspaceRequest(`${firstCommitmentsPath}/${raceCommitmentId}`, {
      method: 'PATCH',
      cookie: secondCookie,
      body: { status: 'DISMISSED' },
    }),
  ]);
  assert.deepEqual(
    concurrentTransitions.map((response) => response.status).sort(),
    [200, 409],
    'Concurrent terminal transitions must serialize against the current database status.',
  );

  const duplicateMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members`,
    { method: 'POST', cookie, body: { email: secondEmail } },
  );
  assert.equal(duplicateMemberResponse.status, 409, 'Adding an existing member must be rejected.');

  const unregisteredMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members`,
    { method: 'POST', cookie, body: { email: 'not-registered@example.test' } },
  );
  assert.equal(unregisteredMemberResponse.status, 404, 'Only registered accounts can be added.');

  const memberWorkspaceDetails = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}`, {
    cookie: secondCookie,
  });
  assert.equal(memberWorkspaceDetails.status, 200, 'Workspace members should have access.');
  assert.equal((await memberWorkspaceDetails.json()).workspace.role, 'MEMBER');

  const ownerMemberListResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members`,
    { cookie },
  );
  assert.equal(ownerMemberListResponse.status, 200);
  const ownerMemberList = (await ownerMemberListResponse.json()).members;
  assert.equal(ownerMemberList.length, 2);
  assert.equal(
    ownerMemberList.find((member) => member.userId === registrationResult.user.id)?.role,
    'OWNER',
  );
  assert.equal(
    ownerMemberList.find((member) => member.userId === secondRegistrationResult.user.id)?.role,
    'MEMBER',
  );

  const memberMemberListResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members`,
    { cookie: secondCookie },
  );
  assert.equal(memberMemberListResponse.status, 200, 'Members may list their workspace members.');
  assert.equal((await memberMemberListResponse.json()).members.length, 2);

  const memberCannotAdd = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}/members`, {
    method: 'POST',
    cookie: secondCookie,
    body: { email },
  });
  assert.equal(memberCannotAdd.status, 403, 'Only owners may add members.');

  const memberCannotChangeRole = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${registrationResult.user.id}`,
    { method: 'PATCH', cookie: secondCookie, body: { role: 'MEMBER' } },
  );
  assert.equal(memberCannotChangeRole.status, 403, 'Only owners may change member roles.');

  const memberCannotRemove = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${registrationResult.user.id}`,
    { method: 'DELETE', cookie: secondCookie },
  );
  assert.equal(memberCannotRemove.status, 403, 'Only owners may remove members.');

  const invalidRoleChange = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${secondRegistrationResult.user.id}`,
    { method: 'PATCH', cookie, body: { role: 'ADMIN' } },
  );
  assert.equal(invalidRoleChange.status, 400, 'Roles outside the MVP role enum must be rejected.');

  const lastOwnerCannotBeDemoted = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${registrationResult.user.id}`,
    { method: 'PATCH', cookie, body: { role: 'MEMBER' } },
  );
  assert.equal(lastOwnerCannotBeDemoted.status, 409, 'A workspace must retain an owner.');

  const lastOwnerCannotBeRemoved = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${registrationResult.user.id}`,
    { method: 'DELETE', cookie },
  );
  assert.equal(lastOwnerCannotBeRemoved.status, 409, 'The final owner cannot be removed.');

  const ownerRemoveMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${secondRegistrationResult.user.id}`,
    { method: 'DELETE', cookie },
  );
  assert.equal(ownerRemoveMemberResponse.status, 200, 'Owners should be able to remove members.');
  assert.equal((await ownerRemoveMemberResponse.json()).removed, true);
  const memberRemovedEvents = await pool.query(
    `SELECT actor_user_id, target_user_id, event_type, details
     FROM commitmentos.workspace_audit_event
     WHERE workspace_id = $1 AND event_type = 'MEMBER_REMOVED'
       AND target_user_id = $2`,
    [firstWorkspace.id, secondRegistrationResult.user.id],
  );
  assert.ok(
    memberRemovedEvents.rows.some(
      (event) =>
        event.actor_user_id === registrationResult.user.id && event.details.role === 'MEMBER',
    ),
    'Member removals must retain an immutable record of actor, target, and prior role.',
  );
  const removedMemberCannotSelectWorkspace = await appPageRequest(
    `/app?workspaceId=${firstWorkspace.id}`,
    secondCookie,
  );
  await assertAppPageUnavailable(removedMemberCannotSelectWorkspace, ['Product Team']);
  const removedOwnerDetail = await appPageRequest(
    `/app/commitments/${apiCommitment.id}?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(removedOwnerDetail.status, 200);
  const removedOwnerDetailBody = await removedOwnerDetail.text();
  assert.match(removedOwnerDetailBody, /Unknown/);
  assert.ok(!removedOwnerDetailBody.includes('Second Integration User'));

  const readdedMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members`,
    {
      method: 'POST',
      cookie,
      body: { email: secondEmail },
    },
  );
  assert.equal(readdedMemberResponse.status, 201);
  const readdedOwnerDetail = await appPageRequest(
    `/app/commitments/${apiCommitment.id}?workspaceId=${firstWorkspace.id}`,
    cookie,
  );
  assert.equal(readdedOwnerDetail.status, 200);
  assert.match(await readdedOwnerDetail.text(), /Second Integration User/);

  const promoteMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${secondRegistrationResult.user.id}`,
    { method: 'PATCH', cookie, body: { role: 'OWNER' } },
  );
  assert.equal(promoteMemberResponse.status, 200, 'Owners should be able to promote a member.');
  assert.equal((await promoteMemberResponse.json()).member.role, 'OWNER');
  const roleChangeEvents = await pool.query(
    `SELECT actor_user_id, target_user_id, event_type, details
     FROM commitmentos.workspace_audit_event
     WHERE workspace_id = $1 AND event_type = 'MEMBER_ROLE_CHANGED'
       AND target_user_id = $2`,
    [firstWorkspace.id, secondRegistrationResult.user.id],
  );
  assert.ok(
    roleChangeEvents.rows.some(
      (event) =>
        event.actor_user_id === registrationResult.user.id &&
        event.details.fromRole === 'MEMBER' &&
        event.details.toRole === 'OWNER',
    ),
    'Role changes must be recorded with their actor, target, and before/after roles.',
  );

  const concurrentOwnerDemotions = await Promise.all([
    workspaceRequest(`/api/workspaces/${firstWorkspace.id}/members/${registrationResult.user.id}`, {
      method: 'PATCH',
      cookie,
      body: { role: 'MEMBER' },
    }),
    workspaceRequest(
      `/api/workspaces/${firstWorkspace.id}/members/${secondRegistrationResult.user.id}`,
      { method: 'PATCH', cookie, body: { role: 'MEMBER' } },
    ),
  ]);
  const concurrentDemotionStatuses = concurrentOwnerDemotions.map((response) => response.status);
  assert.ok(
    concurrentDemotionStatuses.includes(200),
    'At least one owner demotion should be applied.',
  );
  assert.ok(
    concurrentDemotionStatuses.every((status) => [200, 403, 409].includes(status)),
    'Concurrent owner mutations must finish or be rejected after observing the updated role.',
  );

  const remainingOwners = await pool.query(
    `SELECT user_id
     FROM commitmentos.workspace_member
     WHERE workspace_id = $1 AND role = 'OWNER'`,
    [firstWorkspace.id],
  );
  assert.equal(
    remainingOwners.rows.length,
    1,
    'Exactly one owner must remain after concurrent demotions.',
  );
  const finalOwnerId = remainingOwners.rows[0].user_id;
  const finalOwnerCookie = finalOwnerId === registrationResult.user.id ? cookie : secondCookie;

  const finalOwnerCannotBeDemoted = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${finalOwnerId}`,
    { method: 'PATCH', cookie: finalOwnerCookie, body: { role: 'MEMBER' } },
  );
  assert.equal(finalOwnerCannotBeDemoted.status, 409);

  const finalOwnerCannotBeRemoved = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${finalOwnerId}`,
    { method: 'DELETE', cookie: finalOwnerCookie },
  );
  assert.equal(finalOwnerCannotBeRemoved.status, 409);

  const thirdWorkspaceResponse = await workspaceRequest('/api/workspaces', {
    method: 'POST',
    cookie: secondCookie,
    body: { name: 'Customer Success' },
  });
  assert.equal(thirdWorkspaceResponse.status, 201);
  const thirdWorkspace = (await thirdWorkspaceResponse.json()).workspace;
  workspaceIds.push(thirdWorkspace.id);
  assert.equal(thirdWorkspace.role, 'OWNER');

  const finalFirstUserList = await workspaceRequest('/api/workspaces', { cookie });
  const firstUserWorkspaceIds = (await finalFirstUserList.json()).workspaces.map((item) => item.id);
  assert.deepEqual(
    new Set(firstUserWorkspaceIds),
    new Set([firstWorkspace.id, secondWorkspace.id]),
  );

  const finalSecondUserList = await workspaceRequest('/api/workspaces', { cookie: secondCookie });
  const secondUserWorkspaceIds = (await finalSecondUserList.json()).workspaces.map(
    (item) => item.id,
  );
  assert.deepEqual(
    new Set(secondUserWorkspaceIds),
    new Set([firstWorkspace.id, thirdWorkspace.id]),
  );

  const secondUserCannotReadSecondWorkspace = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}`,
    { cookie: secondCookie },
  );
  assert.equal(
    secondUserCannotReadSecondWorkspace.status,
    404,
    'Non-members must not be able to access another workspace.',
  );

  const nonMemberCannotListSecondWorkspaceMembers = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/members`,
    { cookie: secondCookie },
  );
  assert.equal(nonMemberCannotListSecondWorkspaceMembers.status, 404);

  const nonMemberCannotAddToSecondWorkspace = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/members`,
    { method: 'POST', cookie: secondCookie, body: { email } },
  );
  assert.equal(nonMemberCannotAddToSecondWorkspace.status, 404);

  const nonMemberCannotChangeSecondWorkspaceRole = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/members/${registrationResult.user.id}`,
    { method: 'PATCH', cookie: secondCookie, body: { role: 'MEMBER' } },
  );
  assert.equal(nonMemberCannotChangeSecondWorkspaceRole.status, 404);

  const nonMemberCannotRemoveFromSecondWorkspace = await workspaceRequest(
    `/api/workspaces/${secondWorkspace.id}/members/${registrationResult.user.id}`,
    { method: 'DELETE', cookie: secondCookie },
  );
  assert.equal(nonMemberCannotRemoveFromSecondWorkspace.status, 404);

  const firstUserCannotReadThirdWorkspace = await workspaceRequest(
    `/api/workspaces/${thirdWorkspace.id}`,
    { cookie },
  );
  assert.equal(firstUserCannotReadThirdWorkspace.status, 404);
  const firstUserCannotSelectThirdWorkspace = await appPageRequest(
    `/app/settings?workspaceId=${thirdWorkspace.id}`,
    cookie,
  );
  await assertAppPageUnavailable(firstUserCannotSelectThirdWorkspace, ['Customer Success']);

  const logout = await authRequest('sign-out', {}, cookie);
  assert.ok(logout.ok, 'Logout should complete successfully.');

  const invalidatedPage = await fetch(`${baseURL}/app`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(invalidatedPage.status, 307, 'A logged-out session must no longer access /app.');
  assert.match(invalidatedPage.headers.get('cache-control') ?? '', /no-store/i);
  const invalidatedWorkspaceList = await workspaceRequest('/api/workspaces', { cookie });
  assert.equal(
    invalidatedWorkspaceList.status,
    401,
    'Logout must revoke workspace API access too.',
  );

  const remainingSessions = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM commitmentos.session
     WHERE user_id = (SELECT id FROM commitmentos."user" WHERE email = $1)`,
    [email],
  );
  assert.equal(remainingSessions.rows[0].count, 0, 'Logout must invalidate the database session.');

  await testPasswordRecovery();
  console.log('Authentication, workspace, commitment, and recovery integration checks passed.');
} catch (error) {
  const stackFrame =
    error instanceof Error
      ? error.stack?.split('\n').find((line) => line.includes('test-auth-integration.mjs:'))
      : undefined;
  const diagnostic =
    error instanceof Error
      ? `${error.name}: ${error.message}${stackFrame ? `\n${stackFrame.trim()}` : ''}`
      : String(error);
  const escapedDiagnostic = diagnostic
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  console.error('Authentication integration test failed.', error);
  process.stdout.write(`::error title=Authentication integration failure::${escapedDiagnostic}\n`);
  process.exitCode = 1;
} finally {
  await cleanupServer();
  await cleanupEmailServer();
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
    await cleanupClient.query(
      'DELETE FROM commitmentos.email_verification_token_use WHERE token_hash = ANY($1::text[])',
      [verificationTokenHashes],
    );
    await cleanupClient.query(
      `DELETE FROM commitmentos.rate_limit
       WHERE split_part(key, '|', 1) = ANY($1::text[])`,
      [rateLimitTestIps],
    );
    // The test database contains only disposable fixtures; preserve production immutability rules.
    await cleanupClient.query(
      'ALTER TABLE commitmentos.commitment_audit_event DISABLE TRIGGER USER',
    );
    await cleanupClient.query(
      `DELETE FROM commitmentos.commitment_audit_event
       WHERE workspace_id = ANY($1::text[])
          OR actor_user_id IN (
            SELECT id FROM commitmentos."user" WHERE email = ANY($2::text[])
          )`,
      [workspaceIds, testEmails],
    );
    await cleanupClient.query(
      'ALTER TABLE commitmentos.commitment_audit_event ENABLE TRIGGER USER',
    );
    await cleanupClient.query(
      'ALTER TABLE commitmentos.workspace_audit_event DISABLE TRIGGER USER',
    );
    await cleanupClient.query(
      `DELETE FROM commitmentos.workspace_audit_event
       WHERE workspace_id = ANY($1::text[])
          OR actor_user_id IN (
            SELECT id FROM commitmentos."user" WHERE email = ANY($2::text[])
          )
          OR target_user_id IN (
            SELECT id FROM commitmentos."user" WHERE email = ANY($2::text[])
          )`,
      [workspaceIds, testEmails],
    );
    await cleanupClient.query('ALTER TABLE commitmentos.workspace_audit_event ENABLE TRIGGER USER');
    await cleanupClient.query(
      'DELETE FROM commitmentos.commitment WHERE workspace_id = ANY($1::text[])',
      [workspaceIds],
    );
    await cleanupClient.query(
      'DELETE FROM commitmentos.source_message WHERE workspace_id = ANY($1::text[])',
      [workspaceIds],
    );
    await cleanupClient.query('DELETE FROM commitmentos.workspace WHERE id = ANY($1::text[])', [
      workspaceIds,
    ]);
    await cleanupClient.query('DELETE FROM commitmentos."user" WHERE email = ANY($1::text[])', [
      testEmails,
    ]);
    await cleanupClient.query('COMMIT');
  } catch (error) {
    await cleanupClient.query('ROLLBACK').catch((rollbackError) => {
      console.error('Integration fixture cleanup rollback failed.', rollbackError);
    });
    console.error('Integration fixture cleanup failed.', error);
    process.exitCode = 1;
  } finally {
    cleanupClient.release();
    await pool.end();
  }
}
