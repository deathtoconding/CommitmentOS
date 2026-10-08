import { auth } from './server';

export async function getAuthenticatedSession(requestHeaders: Headers) {
  return auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
}
