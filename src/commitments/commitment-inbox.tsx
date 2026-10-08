import type { Commitment } from './model';
import { commitmentStatusLabel, formatCommitmentDeadline } from './presentation';

type CommitmentInboxProps = {
  commitments: readonly Commitment[];
};

function CommitmentInboxEmptyState() {
  return (
    <div className="app-empty-state commitment-inbox-empty-state">
      <div aria-hidden="true" className="app-empty-art">
        <span className="app-empty-orbit app-empty-orbit-one" />
        <span className="app-empty-orbit app-empty-orbit-two" />
        <span className="app-empty-icon">
          <svg
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
          >
            <path d="M4 5.5h16l1.2 10.2a2 2 0 0 1-2 2.3H4.8a2 2 0 0 1-2-2.3L4 5.5Z" />
            <path d="M3.2 14.5h5l1.3 2h5l1.3-2h5" />
          </svg>
        </span>
        <span className="app-empty-spark app-empty-spark-one" />
        <span className="app-empty-spark app-empty-spark-two" />
      </div>
      <p className="app-empty-kicker">Commitment inbox</p>
      <h2>No commitments yet.</h2>
      <p>Commitments recorded for this workspace will appear here.</p>
    </div>
  );
}

export function CommitmentInbox({ commitments }: CommitmentInboxProps) {
  if (commitments.length === 0) return <CommitmentInboxEmptyState />;

  return (
    <section aria-labelledby="commitment-inbox-heading" className="commitment-inbox-panel">
      <header className="commitment-inbox-summary">
        <div>
          <p className="commitment-inbox-eyebrow">Workspace records</p>
          <h2 id="commitment-inbox-heading">Commitments</h2>
        </div>
        <span aria-label={`${commitments.length} commitments`} className="commitment-inbox-count">
          {commitments.length} {commitments.length === 1 ? 'item' : 'items'}
        </span>
      </header>

      <ol aria-label="Commitment inbox" className="commitment-inbox-list">
        {commitments.map((commitment) => (
          <li key={commitment.id}>
            <article className="commitment-inbox-card">
              <div className="commitment-inbox-card-heading">
                <div className="commitment-inbox-card-copy">
                  <h3>{commitment.normalizedAction}</h3>
                  <p>{commitment.commitmentText}</p>
                </div>
                <span
                  className="commitment-status-pill"
                  data-status={commitment.status.toLowerCase()}
                >
                  {commitmentStatusLabel(commitment.status)}
                </span>
              </div>

              <dl className="commitment-inbox-metadata">
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
              </dl>
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}
