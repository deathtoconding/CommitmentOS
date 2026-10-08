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

  const addMemberResponse = await workspaceRequest(`/api/workspaces/${firstWorkspace.id}/members`, {
    method: 'POST',
    cookie,
    body: { email: secondEmail },
  });
  assert.equal(addMemberResponse.status, 201, 'Owners should be able to add registered users.');
  const addedMember = (await addMemberResponse.json()).member;
  assert.equal(addedMember.userId, secondRegistrationResult.user.id);
  assert.equal(addedMember.role, 'MEMBER');

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
