import {
  commitmentAuditEventCursorSchema,
  commitmentAuditEventLimitSchema,
} from '@/commitments/schemas';
import { getWorkspaceCommitment, listWorkspaceCommitmentAuditEvents } from '@/commitments/service';
import { requireWorkspaceMember } from '@/workspaces/authorization';
import {
  internalErrorResponse,
  invalidRequestResponse,
  notFoundResponse,
  workspaceResponse,
} from '@/workspaces/responses';

type WorkspaceCommitmentAuditRouteContext = {
  params: Promise<{ id: string; commitmentId: string }>;
};

export async function GET(
  request: Request,
  context: WorkspaceCommitmentAuditRouteContext,
): Promise<Response> {
  const { id, commitmentId } = await context.params;
  const access = await requireWorkspaceMember(request.headers, id);
  if (!access.authorized) {
    return access.response;
  }

  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if ((key !== 'limit' && key !== 'cursor') || url.searchParams.getAll(key).length !== 1) {
      return invalidRequestResponse();
    }
  }

  const rawLimit = url.searchParams.get('limit');
  const parsedLimit =
    rawLimit === null
      ? { success: true as const, data: 50 }
      : commitmentAuditEventLimitSchema.safeParse(rawLimit);
  if (!parsedLimit.success) {
    return invalidRequestResponse();
  }

  let cursor: { id: string; occurredAt: Date } | null = null;
  const rawCursor = url.searchParams.get('cursor');
  if (rawCursor !== null) {
    if (rawCursor.length > 2_048) {
      return invalidRequestResponse();
    }

    try {
      const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as unknown;
      const parsedCursor = commitmentAuditEventCursorSchema.safeParse(decoded);
      if (!parsedCursor.success) {
        return invalidRequestResponse();
      }
      cursor = {
        id: parsedCursor.data.id,
        occurredAt: new Date(parsedCursor.data.occurredAt),
      };
    } catch {
      return invalidRequestResponse();
    }
  }

  try {
    const commitment = await getWorkspaceCommitment(access.value.workspace.id, commitmentId);
    if (!commitment) {
      return notFoundResponse();
    }

    const results = await listWorkspaceCommitmentAuditEvents(
      access.value.workspace.id,
      commitmentId,
      parsedLimit.data,
      cursor,
    );
    const hasMore = results.length > parsedLimit.data;
    const events = hasMore ? results.slice(0, parsedLimit.data) : results;
    const lastEvent = events.at(-1);
    const nextCursor =
      hasMore && lastEvent
        ? Buffer.from(
            JSON.stringify({ id: lastEvent.id, occurredAt: lastEvent.occurredAt.toISOString() }),
          ).toString('base64url')
        : null;

    return workspaceResponse({ events, nextCursor });
  } catch {
    return internalErrorResponse();
  }
}
