export function workspaceResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export function unauthenticatedResponse(): Response {
  return workspaceResponse({ error: 'UNAUTHENTICATED' }, 401);
}

export function invalidRequestResponse(): Response {
  return workspaceResponse({ error: 'INVALID_REQUEST' }, 400);
}

export function notFoundResponse(): Response {
  return workspaceResponse({ error: 'NOT_FOUND' }, 404);
}

export function forbiddenResponse(): Response {
  return workspaceResponse({ error: 'FORBIDDEN' }, 403);
}

export function internalErrorResponse(): Response {
  return workspaceResponse({ error: 'INTERNAL_SERVER_ERROR' }, 500);
}
