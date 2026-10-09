import { describe, expect, it } from 'vitest';
import {
  GMAIL_OAUTH_BROWSER_COOKIE,
  isSameOriginMutation,
  isSameOriginNavigation,
  readCookie,
} from './http';

describe('Gmail integration HTTP security helpers', () => {
  it('requires an exact same-origin Origin and rejects cross-site fetch metadata', () => {
    expect(
      isSameOriginMutation(
        new Request('https://commitmentos.example.test/integrations', {
          method: 'POST',
          headers: { origin: 'https://commitmentos.example.test', 'sec-fetch-site': 'same-origin' },
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginMutation(
        new Request('https://commitmentos.example.test/integrations', {
          method: 'POST',
          headers: { origin: 'https://attacker.example.test' },
        }),
      ),
    ).toBe(false);
    expect(
      isSameOriginMutation(
        new Request('https://commitmentos.example.test/integrations', { method: 'POST' }),
      ),
    ).toBe(false);
    expect(
      isSameOriginMutation(
        new Request('https://commitmentos.example.test/integrations', {
          method: 'POST',
          headers: { origin: 'https://commitmentos.example.test', 'sec-fetch-site': 'cross-site' },
        }),
      ),
    ).toBe(false);
  });

  it('accepts the public preview origin when the framework request URL is internal', () => {
    const request = new Request('http://0.0.0.0:3000/connect', {
      headers: {
        origin: 'https://3000-session.e2b.app',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-host': '3000-session.e2b.app',
        'x-forwarded-proto': 'https',
      },
    });
    expect(isSameOriginMutation(request)).toBe(true);
    expect(isSameOriginNavigation(request)).toBe(true);
  });

  it('rejects cross-site OAuth-start navigations while allowing same-origin starts', () => {
    expect(
      isSameOriginNavigation(
        new Request('https://commitmentos.example.test/connect', {
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
      ),
    ).toBe(false);
    expect(
      isSameOriginNavigation(
        new Request('https://commitmentos.example.test/connect', {
          headers: { origin: 'https://commitmentos.example.test', 'sec-fetch-site': 'same-origin' },
        }),
      ),
    ).toBe(true);
    expect(isSameOriginNavigation(new Request('https://commitmentos.example.test/connect'))).toBe(
      false,
    );
  });

  it('reads only the expected bounded base64url OAuth browser cookie', () => {
    const browserToken = 'a'.repeat(43);
    const request = new Request('https://commitmentos.example.test/callback', {
      headers: { cookie: `other=value; ${GMAIL_OAUTH_BROWSER_COOKIE}=${browserToken}` },
    });
    expect(readCookie(request, GMAIL_OAUTH_BROWSER_COOKIE)).toBe(browserToken);
    expect(
      readCookie(
        new Request('https://commitmentos.example.test/callback', {
          headers: { cookie: `${GMAIL_OAUTH_BROWSER_COOKIE}=bad%20value` },
        }),
        GMAIL_OAUTH_BROWSER_COOKIE,
      ),
    ).toBeNull();
    expect(
      readCookie(
        new Request('https://commitmentos.example.test/callback', {
          headers: { cookie: `${GMAIL_OAUTH_BROWSER_COOKIE}=${'a'.repeat(9000)}` },
        }),
        GMAIL_OAUTH_BROWSER_COOKIE,
      ),
    ).toBeNull();
  });
});
