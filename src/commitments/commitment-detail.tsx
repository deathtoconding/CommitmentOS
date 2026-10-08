import type { CommitmentAuditEventType } from './audit-model';
import type { Commitment, CommitmentStatus } from './model';
import { COMMITMENT_STATUSES } from './model';
import { commitmentStatusLabel, formatCommitmentDeadline } from './presentation';

type CommitmentAuditTimelineEvent = {
  id: string;
  actorUserId: string;
  eventType: CommitmentAuditEventType;
  details: Record<string, unknown>;
  occurredAt: Date;
};

type CommitmentDetailProps = {
  commitment: Commitment;
  workspaceId: string;
  auditEvents: readonly CommitmentAuditTimelineEvent[];
  nextAuditCursor: string | null;
};

function isCommitmentStatus(value: unknown): value is CommitmentStatus {
  return typeof value === 'string' && (COMMITMENT_STATUSES as readonly string[]).includes(value);
}

function auditEventCopy(event: CommitmentAuditTimelineEvent): { title: string; detail?: string } {
  if (event.eventType === 'STATUS_CHANGED') {
    const fromStatus = event.details.fromStatus;
    const toStatus = event.details.toStatus;
    if (isCommitmentStatus(fromStatus) && isCommitmentStatus(toStatus)) {
      return {
        title: 'Status changed',
        detail: `${commitmentStatusLabel(fromStatus)} → ${commitmentStatusLabel(toStatus)}`,
      };
    }
  }

  const summaries: Record<CommitmentAuditEventType, string> = {
    CREATED: 'Commitment created',
    EDITED: 'Commitment details updated',
    CONFIRMED: 'Commitment confirmed',
    DISMISSED: 'Commitment dismissed',
    REASSIGNED: 'Owner assignment changed',
    DEADLINE_CHANGED: 'Deadline updated',
    STATUS_CHANGED: 'Status changed',
    COMPLETED: 'Commitment completed',
    COMPLETION_EVIDENCE_RECORDED: 'Completion evidence recorded',
    FOLLOW_UP_GENERATED: 'Follow-up generated',
    APPROVED: 'Follow-up approved',
    SENT: 'Message sent',
  };

  return { title: summaries[event.eventType] };
}

function CommitmentAuditTimeline({
  auditEvents,
  nextAuditCursor,
  commitmentId,
  workspaceId,
}: {
  auditEvents: readonly CommitmentAuditTimelineEvent[];
  nextAuditCursor: string | null;
  commitmentId: string;
  workspaceId: string;
}) {
  const olderEventsQuery =
    nextAuditCursor === null
      ? null
      : new URLSearchParams({ auditCursor: nextAuditCursor, workspaceId });

  return (
    <section aria-labelledby="commitment-audit-title" className="commitment-audit-card">
      <div className="commitment-detail-card-heading">
        <div>
          <p className="commitment-inbox-eyebrow">Immutable history</p>
          <h2 id="commitment-audit-title">Activity</h2>
        </div>
      </div>

      {auditEvents.length === 0 ? (
        <p className="commitment-audit-empty">No audit activity is available for this record.</p>
      ) : (
        <ol aria-label="Commitment audit timeline" className="commitment-audit-list">
          {auditEvents.map((event) => {
            const copy = auditEventCopy(event);
            return (
              <li className="commitment-audit-event" key={event.id}>
                <span aria-hidden="true" className="commitment-audit-marker" />
                <div className="commitment-audit-event-copy">
                  <h3>{copy.title}</h3>
                  {copy.detail ? <p>{copy.detail}</p> : null}
                  <span>Recorded by a workspace member</span>
                </div>
                <time dateTime={event.occurredAt.toISOString()}>
                  {formatCommitmentDeadline(event.occurredAt, null)}
                </time>
              </li>
            );
          })}
        </ol>
      )}

      {olderEventsQuery ? (
        <a
          className="commitment-audit-more"
          href={`/app/commitments/${encodeURIComponent(commitmentId)}?${olderEventsQuery.toString()}`}
        >
          Load older activity
        </a>
      ) : null}
    </section>
  );
}

export function CommitmentDetail({
  commitment,
  workspaceId,
  auditEvents,
  nextAuditCursor,
}: CommitmentDetailProps) {
  const inboxQuery = new URLSearchParams({ workspaceId });

  return (
    <section aria-labelledby="commitment-detail-title" className="app-page commitment-detail-page">
      <header className="app-page-header">
        <div>
          <p className="app-page-eyebrow">Commitment details</p>
          <h1 id="commitment-detail-title">{commitment.normalizedAction}</h1>
          <p className="app-page-description">{commitment.commitmentText}</p>
        </div>
        <span
          className="commitment-status-pill commitment-detail-status"
          data-status={commitment.status.toLowerCase()}
        >
          {commitmentStatusLabel(commitment.status)}
        </span>
      </header>

      <section aria-labelledby="commitment-information-title" className="commitment-detail-card">
        <div className="commitment-detail-card-heading">
          <div>
            <p className="commitment-inbox-eyebrow">Workspace record</p>
            <h2 id="commitment-information-title">Commitment information</h2>
          </div>
        </div>
        <dl className="commitment-detail-metadata">
          <div>
            <dt>Owner</dt>
            <dd>{commitment.ownerUserId ? 'Assigned' : 'Unassigned'}</dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>
              {commitment.dueAt ? (
                <time dateTime={commitment.dueAt.toISOString()}>
                  {formatCommitmentDeadline(commitment.dueAt, commitment.dueTimezone)}
                </time>
              ) : (
                'No deadline set'
              )}
            </dd>
          </div>
          {commitment.counterpartyName ? (
            <div>
              <dt>Counterparty</dt>
              <dd>{commitment.counterpartyName}</dd>
            </div>
          ) : null}
          <div>
            <dt>Created</dt>
            <dd>
              <time dateTime={commitment.createdAt.toISOString()}>
                {formatCommitmentDeadline(commitment.createdAt, null)}
              </time>
            </dd>
          </div>
        </dl>
      </section>

      <CommitmentAuditTimeline
        auditEvents={auditEvents}
        commitmentId={commitment.id}
        nextAuditCursor={nextAuditCursor}
        workspaceId={workspaceId}
      />

      <a className="commitment-detail-back-link" href={`/app/inbox?${inboxQuery.toString()}`}>
        <span aria-hidden="true">←</span>
        Back to commitment inbox
      </a>
    </section>
  );
}
