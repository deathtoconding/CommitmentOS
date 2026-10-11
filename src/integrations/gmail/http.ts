import { getAuthEnvironment } from '../../auth/environment';

export const GMAIL_OAUTH_BROWSER_COOKIE = 'commitmentos_gmail_oauth_browser';
export const GMAIL_OAUTH_CALLBACK_PATH = '/api/integrations/gmail/callback';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export function gmailApiError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: privateHeaders });
}

function forwardedHeaderValue(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.split(',', 1)[0]?.trim();
  return value ? value : null;
}

function requestOriginCandidates(request: Request): Set<string> {
  const candidates = new Set<string>();
  try {
    candidates.add(new URL(request.url).origin);
  } catch {
    return candidates;
  }

  const host =
    forwardedHeaderValue(request, 'x-forwarded-host') ?? forwardedHeaderValue(request, 'host');
  const protocol =
    forwardedHeaderValue(request, 'x-forwarded-proto') ??
    new URL(request.url).protocol.slice(0, -1);
  if (!host || !['http', 'https'].includes(protocol)) return candidates;
  try {
    candidates.add(new URL(`${protocol}://${host}`).origin);
  } catch {
    // Ignore malformed proxy metadata and retain the canonical request URL candidate.
  }
  return candidates;
}

export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    if (!requestOriginCandidates(request).has(new URL(origin).origin)) return false;
  } catch {
    return false;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin';
}

export function isSameOriginNavigation(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') return false;
  if (!origin) return fetchSite === 'same-origin';
  try {
    return requestOriginCandidates(request).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader || cookieHeader.length > 8192) return null;
  for (const cookie of cookieHeader.split(';')) {
    const [cookieName, ...valueParts] = cookie.trim().split('=');
    if (cookieName !== name) continue;
    const value = valueParts.join('=');
    return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
  }
  return null;
}

export function createGmailOAuthCookie(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${GMAIL_OAUTH_BROWSER_COOKIE}=${value}; Path=${GMAIL_OAUTH_CALLBACK_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearGmailOAuthCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${GMAIL_OAUTH_BROWSER_COOKIE}=; Path=${GMAIL_OAUTH_CALLBACK_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function gmailIntegrationRedirect(
  workspaceId: string | null,
  result: 'connected' | 'error' | 'disconnected' | 'revocation-pending',
  clearCookie = false,
): Response {
  const authEnvironment = getAuthEnvironment();
  const location = new URL('/app/integrations', authEnvironment.baseURL);
  if (workspaceId) location.searchParams.set('workspaceId', workspaceId);
  location.searchParams.set('gmail', result);
  const headers = new Headers({
    ...privateHeaders,
    Location: location.toString(),
  });
  if (clearCookie) headers.set('Set-Cookie', clearGmailOAuthCookie());
  return new Response(null, { status: 303, headers });
}
