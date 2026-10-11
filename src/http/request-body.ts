const DEFAULT_MAX_REQUEST_BODY_BYTES = 256 * 1024;

export type BoundedBodyResult =
  { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: 'invalid' | 'too-large' };

export type JsonRequestBodyResult =
  { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too-large' };

export async function readBoundedRequestBody(
  request: Request,
  maximumBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<BoundedBodyResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('maximumBytes must be a nonnegative safe integer.');
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const normalizedLength = contentLength.trim();
    if (!/^\d+$/.test(normalizedLength)) {
      return { ok: false, reason: 'invalid' };
    }
    if (Number(normalizedLength) > maximumBytes) {
      return { ok: false, reason: 'too-large' };
    }
  }

  if (!request.body) {
    return { ok: true, bytes: new Uint8Array() };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'invalid' };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, bytes };
}

export async function readJsonRequestBody(
  request: Request,
  maximumBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<JsonRequestBodyResult> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (
    mediaType !== 'application/json' &&
    !(mediaType?.startsWith('application/') && mediaType.endsWith('+json'))
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const boundedBody = await readBoundedRequestBody(request, maximumBytes);
  if (!boundedBody.ok) return boundedBody;

  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(boundedBody.bytes));
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
