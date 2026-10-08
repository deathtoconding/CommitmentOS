import { Buffer } from 'node:buffer';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getAuthenticatedSession } from '@/auth/session';
import { CommitmentDetail } from '@/commitments/commitment-detail';
import { commitmentAuditEventCursorSchema } from '@/commitments/schemas';
import { getWorkspaceCommitment, listWorkspaceCommitmentAuditEvents } from '@/commitments/service';
import { resolveActiveWorkspace } from '@/workspaces/active-workspace';
import { listUserWorkspaces } from '@/workspaces/queries';
import type { AppSearchParams } from '@/app-shell/section-page';

const AUDIT_PAGE_SIZE = 50;

type CommitmentDetailPageProps = {
  params: Promise<{ commitmentId: string }>;
  searchParams: Promise<AppSearchParams>;
};

function parseAuditCursor(rawCursor: string | undefined) {
  if (rawCursor === undefined) return null;
  if (rawCursor.length > 2_048) notFound();

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    notFound();
  }

  const parsedCursor = commitmentAuditEventCursorSchema.safeParse(decoded);
  if (!parsedCursor.success) notFound();

  return {
    id: parsedCursor.data.id,
    occurredAt: new Date(parsedCursor.data.occurredAt),
  };
}

export default async function CommitmentDetailPage({
  params,
  searchParams,
}: CommitmentDetailPageProps) {
  const currentSession = await getAuthenticatedSession(await headers());
  if (!currentSession) {
    redirect('/login');
  }

  const [{ commitmentId }, query] = await Promise.all([params, searchParams]);
  if (Array.isArray(query.workspaceId) || Array.isArray(query.auditCursor)) {
    notFound();
  }
  const cursor = parseAuditCursor(query.auditCursor);

  const workspaces = await listUserWorkspaces(currentSession.user.id);
  const resolution = resolveActiveWorkspace(workspaces, query.workspaceId);
  if (resolution.status !== 'selected') {
    notFound();
  }

  const record = await getWorkspaceCommitment(resolution.workspace.id, commitmentId);
  if (!record) {
    notFound();
  }

  const results = await listWorkspaceCommitmentAuditEvents(
    resolution.workspace.id,
    record.id,
    AUDIT_PAGE_SIZE,
    cursor,
  );
  const hasMore = results.length > AUDIT_PAGE_SIZE;
  const auditEvents = hasMore ? results.slice(0, AUDIT_PAGE_SIZE) : results;
  const lastEvent = auditEvents.at(-1);
  const nextAuditCursor =
    hasMore && lastEvent
      ? Buffer.from(
          JSON.stringify({ id: lastEvent.id, occurredAt: lastEvent.occurredAt.toISOString() }),
        ).toString('base64url')
      : null;

  return (
    <CommitmentDetail
      auditEvents={auditEvents}
      commitment={record}
      nextAuditCursor={nextAuditCursor}
      workspaceId={resolution.workspace.id}
    />
  );
}
