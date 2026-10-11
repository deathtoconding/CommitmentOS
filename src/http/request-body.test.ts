import { describe, expect, it } from 'vitest';
import { readJsonRequestBody } from './request-body';

function jsonRequest(body: string, contentType = 'application/json') {
  return new Request('https://commitmentos.example/api', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('readJsonRequestBody', () => {
  it('reads JSON below the configured byte limit', async () => {
    const result = await readJsonRequestBody(jsonRequest('{"status":"OPEN"}'), 64);

    expect(result).toEqual({ ok: true, value: { status: 'OPEN' } });
  });

  it('accepts structured JSON media types', async () => {
    const result = await readJsonRequestBody(
      jsonRequest('{"status":"OPEN"}', 'application/vnd.commitmentos+json; charset=utf-8'),
      64,
    );

    expect(result).toEqual({ ok: true, value: { status: 'OPEN' } });
  });

  it('rejects oversized streamed request bodies even without Content-Length', async () => {
    const result = await readJsonRequestBody(jsonRequest('{"value":"too large"}'), 8);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    const request = new Request('https://commitmentos.example/api', {
      method: 'POST',
      headers: { 'content-length': '100', 'content-type': 'application/json' },
      body: '{}',
    });

    const result = await readJsonRequestBody(request, 16);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('rejects non-JSON content types, empty bodies, and invalid JSON', async () => {
    expect(await readJsonRequestBody(jsonRequest('{}', 'text/plain'))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await readJsonRequestBody(jsonRequest(''))).toEqual({ ok: false, reason: 'invalid' });
    expect(await readJsonRequestBody(jsonRequest('{'))).toEqual({ ok: false, reason: 'invalid' });
  });
});
