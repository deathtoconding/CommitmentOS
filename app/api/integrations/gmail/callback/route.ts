import { database } from '@/db/client';
import { requireWorkspaceRole } from '@/workspaces/authorization';
import {
  gmailIntegrationRedirect,
  readCookie,
  GMAIL_OAUTH_BROWSER_COOKIE,
} from '@/integrations/gmail/http';
import { getGmailOAuthEnvironment } from '@/integrations/gmail/environment';
import { decryptIntegrationSecret } from '@/integrations/secret-crypto';
import {
  exchangeGmailAuthorizationCode,
  parseGmailGrantedScopes,
  revokeGmailToken,
  verifyGmailIdentityToken,
} from '@/integrations/gmail/provider';
import {
  createGmailIntegrationService,
  createGmailOAuthStateStore,
} from '@/integrations/gmail/service-core';

const oauthStateStore = createGmailOAuthStateStore(database);
const gmailIntegrationService = createGmailIntegrationService(database);
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const authorizationCodePattern = /^[\x21-\x7E]{1,4096}$/;

function failedCallback(): Response {
  return gmailIntegrationRedirect(null, 'error', true);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.search.length > 16_384) return failedCallback();

  const stateValues = url.searchParams.getAll('state');
  const codeValues = url.searchParams.getAll('code');
  const providerErrorValues = url.searchParams.getAll('error');
  const state = stateValues[0];
  const code = codeValues[0];
  const providerError = providerErrorValues[0];
  const browserToken = readCookie(request, GMAIL_OAUTH_BROWSER_COOKIE);
  if (
    stateValues.length !== 1 ||
    !state ||
    !statePattern.test(state) ||
    !browserToken ||
    codeValues.length > 1 ||
    providerErrorValues.length > 1 ||
    (code && !authorizationCodePattern.test(code)) ||
    (providerError !== undefined && (providerError.length < 1 || providerError.length > 256)) ||
    Boolean(code) === Boolean(providerError)
  ) {
    return failedCallback();
  }

  let flow;
  try {
    flow = await oauthStateStore.consume({ state, browserToken });
  } catch {
    return failedCallback();
  }
  if (!flow) return failedCallback();

  const access = await requireWorkspaceRole(request.headers, flow.workspaceId, ['OWNER']);
  if (!access.authorized || access.value.session.user.id !== flow.userId) {
    return gmailIntegrationRedirect(flow.workspaceId, 'error', true);
  }
  if (providerError) return gmailIntegrationRedirect(flow.workspaceId, 'error', true);

  let configuration;
  try {
    configuration = getGmailOAuthEnvironment();
  } catch {
    return gmailIntegrationRedirect(flow.workspaceId, 'error', true);
  }
  if (!configuration || !code) {
    return gmailIntegrationRedirect(flow.workspaceId, 'error', true);
  }

  let tokenResponse: Awaited<ReturnType<typeof exchangeGmailAuthorizationCode>> | null = null;
  let connectionSaved = false;
  try {
    const codeVerifier = decryptIntegrationSecret(
      flow.codeVerifierCiphertext,
      configuration.encryptionKey,
      `commitmentos:gmail-oauth-state:${flow.stateHash}`,
    );
    tokenResponse = await exchangeGmailAuthorizationCode(configuration, code, codeVerifier);
    const identity = await verifyGmailIdentityToken(
      tokenResponse.id_token,
      configuration.clientId,
      flow.oidcNonceHash,
    );
    const scopes = parseGmailGrantedScopes(tokenResponse.scope);
    await gmailIntegrationService.connect({
      workspaceId: flow.workspaceId,
      actorUserId: flow.userId,
      providerAccountId: identity.sub,
      providerEmail: identity.email,
      scopes,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      accessTokenExpiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      encryptionKey: configuration.encryptionKey,
    });
    connectionSaved = true;
    return gmailIntegrationRedirect(flow.workspaceId, 'connected', true);
  } catch {
    if (tokenResponse && !connectionSaved) {
      await revokeGmailToken(tokenResponse.refresh_token ?? tokenResponse.access_token);
    }
    return gmailIntegrationRedirect(flow.workspaceId, 'error', true);
  }
}
