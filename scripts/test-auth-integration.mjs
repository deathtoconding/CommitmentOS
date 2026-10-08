import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

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
const testEmails = [email, secondEmail];
const password = 'CommitmentOS-Test-Password-2026!';
const workspaceIds = [];
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'commitmentos-integration-test',
});
let server;
let serverOutput = '';

function appendServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-4000);
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
        NODE_ENV: 'production',
        PORT: String(port),
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

function authRequest(path, body, cookie) {
  return fetch(`${baseURL}/api/auth/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: baseURL,
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

async function assertAppPageUnavailable(response, hiddenWorkspaceNames = []) {
  const body = await response.text();
  // A streamed not-found page can carry HTTP 200 after Next has flushed the loading shell.
  assert.ok(
    response.status === 404 || response.status === 200,
    `An inaccessible app page should return 404 or a streamed not-found response, got ${response.status}.`,
  );
  assert.match(body, /Workspace unavailable/);
  for (const workspaceName of hiddenWorkspaceNames) {
    assert.ok(
      !body.includes(workspaceName),
      `The inaccessible workspace ${workspaceName} must stay hidden.`,
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
  return pool.query(
    `INSERT INTO commitmentos.commitment (
       id, workspace_id, owner_user_id, source_message_id, commitment_text,
       normalized_action, counterparty_name, counterparty_email, due_at,
       due_timezone, status, confidence_score, source_excerpt,
       completion_evidence, completed_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     )`,
    [
      id,
      workspaceId,
      ownerUserId,
      sourceMessageId,
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

async function cleanupServer() {
  if (!server || server.exitCode !== null) return;

  const stopped = new Promise((resolveExit) => server.once('exit', resolveExit));
  server.kill('SIGTERM');
  await Promise.race([stopped, delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

try {
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

  const registration = await authRequest('sign-up/email', {
    name: 'CommitmentOS Test User',
    email,
    password,
  });
  assert.ok(registration.ok, 'A new account should register successfully.');
  const registrationResult = await registration.json();
  assert.equal(registrationResult.user.email, email);

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

  const login = await authRequest('sign-in/email', { email, password });
  assert.ok(login.ok, 'Valid credentials should create a session.');
  const cookie = readCookieHeader(login);
  assert.ok(cookie.includes('session_token'), 'Sign-in should set an HTTP session cookie.');

  const authenticatedPage = await fetch(`${baseURL}/app`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(
    authenticatedPage.status,
    200,
    'An authenticated user should be able to access /app.',
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
    ['/app/inbox', 'Your inbox is ready'],
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
  });
  assert.ok(secondRegistration.ok, 'A second user should register for isolation checks.');
  const secondRegistrationResult = await secondRegistration.json();
  assert.equal(secondRegistrationResult.user.email, secondEmail);
  const secondLogin = await authRequest('sign-in/email', { email: secondEmail, password });
  assert.ok(secondLogin.ok, 'The second user should be able to sign in.');
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

  const addMemberResponse = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}/members`, {
    method: 'POST',
    cookie,
    body: { email: secondEmail },
  });
  assert.equal(addMemberResponse.status, 201, 'Owners should be able to add registered users.');
  const addedMember = (await addMemberResponse.json()).member;
  assert.equal(addedMember.userId, secondRegistrationResult.user.id);
  assert.equal(addedMember.role, 'MEMBER');

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

  const repeatedCommitmentStatus = await workspaceRequest(
    `${firstCommitmentsPath}/${apiCommitment.id}`,
    { method: 'PATCH', cookie, body: { status: 'OPEN' } },
  );
  assert.equal(repeatedCommitmentStatus.status, 409);
  assert.equal((await repeatedCommitmentStatus.json()).error, 'INVALID_TRANSITION');

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
  const removedMemberCannotSelectWorkspace = await appPageRequest(
    `/app?workspaceId=${firstWorkspace.id}`,
    secondCookie,
  );
  await assertAppPageUnavailable(removedMemberCannotSelectWorkspace, ['Product Team']);

  const readdedMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members`,
    {
      method: 'POST',
      cookie,
      body: { email: secondEmail },
    },
  );
  assert.equal(readdedMemberResponse.status, 201);

  const promoteMemberResponse = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}/members/${secondRegistrationResult.user.id}`,
    { method: 'PATCH', cookie, body: { role: 'OWNER' } },
  );
  assert.equal(promoteMemberResponse.status, 200, 'Owners should be able to promote a member.');
  assert.equal((await promoteMemberResponse.json()).member.role, 'OWNER');

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

  console.log('Authentication, workspace, and commitment integration checks passed.');
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
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
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
