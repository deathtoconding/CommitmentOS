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

function readCookieHeader(response) {
  const cookies = response.headers.getSetCookie();
  return cookies
    .map((cookie) => cookie.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
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
  assert.match(
    await authenticatedPage.text(),
    new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );

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
  assert.equal((await firstWorkspaceDetails.json()).workspace.id, firstWorkspace.id);

  const secondWorkspaceResponse = await workspaceRequest('/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: 'Operations' },
  });
  assert.equal(secondWorkspaceResponse.status, 201);
  const secondWorkspace = (await secondWorkspaceResponse.json()).workspace;
  workspaceIds.push(secondWorkspace.id);
  assert.equal(secondWorkspace.role, 'OWNER');

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

  const emptySecondUserList = await workspaceRequest('/api/workspaces', { cookie: secondCookie });
  assert.equal(emptySecondUserList.status, 200);
  assert.deepEqual((await emptySecondUserList.json()).workspaces, []);

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
  assert.deepEqual(secondUserWorkspaceIds, [thirdWorkspace.id]);

  const secondUserCannotReadFirstWorkspace = await workspaceRequest(
    `/api/workspaces/${firstWorkspace.id}`,
    { cookie: secondCookie },
  );
  assert.equal(
    secondUserCannotReadFirstWorkspace.status,
    404,
    'Non-members must not be able to access another workspace.',
  );
  const firstUserCannotReadThirdWorkspace = await workspaceRequest(
    `/api/workspaces/${thirdWorkspace.id}`,
    { cookie },
  );
  assert.equal(firstUserCannotReadThirdWorkspace.status, 404);

  const logout = await authRequest('sign-out', {}, cookie);
  assert.ok(logout.ok, 'Logout should complete successfully.');

  const invalidatedPage = await fetch(`${baseURL}/app`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(invalidatedPage.status, 307, 'A logged-out session must no longer access /app.');
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

  console.log('Authentication and workspace integration checks passed.');
} finally {
  await cleanupServer();
  try {
    await pool.query('DELETE FROM commitmentos.workspace WHERE id = ANY($1::text[])', [
      workspaceIds,
    ]);
    await pool.query('DELETE FROM commitmentos."user" WHERE email = ANY($1::text[])', [testEmails]);
  } finally {
    await pool.end();
  }
}
