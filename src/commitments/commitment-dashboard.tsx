import { COMMITMENT_STATUSES } from './model';
import type { WorkspaceCommitmentSummary } from './dashboard-model';
import { commitmentStatusLabel } from './presentation';

type CommitmentDashboardProps = {
  summary: WorkspaceCommitmentSummary;
  workspaceId: string;
};

export function CommitmentDashboard({ summary, workspaceId }: CommitmentDashboardProps) {
  const inboxHref = `/app/inbox?workspaceId=${encodeURIComponent(workspaceId)}`;

  return (
    <section aria-labelledby="commitment-dashboard-heading" className="commitment-dashboard">
      <div className="commitment-dashboard-heading">
        <div>
          <p className="commitment-inbox-eyebrow">Workspace commitments</p>
          <h2 id="commitment-dashboard-heading">A clear view of the work</h2>
          <p>These totals reflect the commitments and lifecycle statuses currently saved here.</p>
        </div>
        <a className="secondary-button commitment-dashboard-link" href={inboxHref}>
          Open commitment inbox
        </a>
      </div>

      <dl aria-label="Workspace commitment summary" className="commitment-dashboard-cards">
        <div className="commitment-dashboard-card">
          <dt>Active commitments</dt>
          <dd>{summary.active}</dd>
          <p>Not completed or dismissed</p>
        </div>
        <div className="commitment-dashboard-card">
          <dt>Needs an owner</dt>
          <dd>{summary.unassigned}</dd>
          <p>Active records without an assigned owner</p>
        </div>
        <div className="commitment-dashboard-card">
          <dt>Due soon</dt>
          <dd>{summary.statusCounts.DUE_SOON}</dd>
          <p>Based on the saved status</p>
        </div>
        <div className="commitment-dashboard-card">
          <dt>Marked overdue</dt>
          <dd>{summary.statusCounts.OVERDUE}</dd>
          <p>Deadlines are not recalculated on this page</p>
        </div>
      </dl>

      <section
        aria-labelledby="commitment-status-breakdown-heading"
        className="dashboard-status-card"
      >
        <div className="dashboard-status-heading">
          <div>
            <h3 id="commitment-status-breakdown-heading">Status breakdown</h3>
            <p>All {summary.total} saved commitments in this workspace</p>
          </div>
        </div>
        <ul className="dashboard-status-list">
          {COMMITMENT_STATUSES.map((status) => (
            <li key={status}>
              <span className="dashboard-status-label">
                <span className="commitment-status-pill" data-status={status.toLowerCase()}>
                  {commitmentStatusLabel(status)}
                </span>
              </span>
              <span
                aria-label={`${commitmentStatusLabel(status)}: ${summary.statusCounts[status]}`}
              >
                {summary.statusCounts[status]}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
