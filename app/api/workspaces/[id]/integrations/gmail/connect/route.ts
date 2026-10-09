import { createHash, randomBytes } from 'node:crypto';
import { database } from '@/db/client';
import { requireWorkspaceRole } from '@/workspaces/authorization';
import {
  createGmailOAuthCookie,
  gmailApiError,
  isSameOriginNavigation,
} from '@/integrations/gmail/http';
import { getGmailOAuthEnvironment } from '@/integrations/gmail/environment';
import { GMAIL_OAUTH_STATE_TTL_MS } from '@/integrations/gmail/model';
import { buildGmailAuthorizationUrl } from '@/integrations/gmail/provider';
import { createGmailOAuthStateStore } from '@/integrations/gmail/service-core';

type RouteContext = { params: Promise<{ id: string }> };
const oauthStateStore = createGmailOAuthStateStore(database);

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id: workspaceId } = await context.params;
  const access = await requireWorkspaceRole(request.headers, workspaceId, ['OWNER']);
  if (!access.authorized) return access.response;
  if (!isSameOriginNavigation(request)) return gmailApiError('CSRF_REJECTED', 403);

  let configuration;
  try {
    configuration = getGmailOAuthEnvironment();
  } catch {
    return gmailApiError('GMAIL_OAUTH_NOT_CONFIGURED', 503);
  }
  if (!configuration) return gmailApiError('GMAIL_OAUTH_NOT_CONFIGURED', 503);

  const state = randomBytes(32).toString('base64url');
  const browserToken = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  try {
    await oauthStateStore.create({
      workspaceId,
      userId: access.value.session.user.id,
      state,
      browserToken,
      nonce,
      codeVerifier,
      encryptionKey: configuration.encryptionKey,
    });
  } catch {
    return gmailApiError('GMAIL_OAUTH_UNAVAILABLE', 503);
  }

  const location = buildGmailAuthorizationUrl(configuration, { state, nonce, codeChallenge });
  return new Response(null, {
    status: 302,
    headers: {
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      Location: location,
      'Set-Cookie': createGmailOAuthCookie(browserToken, GMAIL_OAUTH_STATE_TTL_MS / 1000),
    },
  });
}
