import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getAuthenticatedSession } from '@/auth/session';
import { resolveActiveWorkspace } from '@/workspaces/active-workspace';
import { listUserWorkspaces } from '@/workspaces/queries';

type AppSection = 'dashboard' | 'inbox' | 'commitments' | 'integrations' | 'settings';

export type AppSearchParams = Record<string, string | string[] | undefined>;

type AppSectionPageProps = {
  section: AppSection;
  searchParams: Promise<AppSearchParams>;
};

type SectionCopy = {
  eyebrow: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  icon: 'dashboard' | 'inbox' | 'commitments' | 'integrations';
};

const sectionCopy: Record<Exclude<AppSection, 'settings'>, SectionCopy> = {
  dashboard: {
    eyebrow: 'Workspace overview',
    title: 'Keep every promise in view.',
    description: 'A focused home for the work your team has committed to.',
    emptyTitle: 'Your overview is ready.',
    emptyDescription:
      'As commitments are added, this space will surface the work that needs your attention.',
    icon: 'dashboard',
  },
  inbox: {
    eyebrow: 'Inbox',
    title: 'A place for incoming commitments.',
    description: 'Review and organize commitments from your business conversations.',
    emptyTitle: 'Your inbox is ready.',
    emptyDescription:
      'The commitment-review workflow will appear here when it is available for this workspace.',
    icon: 'inbox',
  },
  commitments: {
    eyebrow: 'Commitments',
    title: 'Follow through, together.',
    description: 'See the work your team has promised and what needs attention next.',
    emptyTitle: 'No commitments to show yet.',
    emptyDescription:
      'Commitment records for this workspace will be available here as the workspace experience grows.',
    icon: 'commitments',
  },
  integrations: {
    eyebrow: 'Integrations',
    title: 'Bring your tools together.',
    description: 'Manage the connections that support your workspace.',
    emptyTitle: 'No integrations are configured here.',
    emptyDescription:
      'Integration settings will become available in a later step. No provider has been connected from this page.',
    icon: 'integrations',
  },
};

function SectionIcon({ name }: { name: SectionCopy['icon'] }) {
  const common = {
    'aria-hidden': true as const,
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.5,
    viewBox: '0 0 24 24',
  };

  switch (name) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect height="6.5" rx="1.5" width="6.5" x="3.75" y="3.75" />
          <rect height="6.5" rx="1.5" width="6.5" x="13.75" y="3.75" />
          <rect height="6.5" rx="1.5" width="6.5" x="3.75" y="13.75" />
          <rect height="6.5" rx="1.5" width="6.5" x="13.75" y="13.75" />
        </svg>
      );
    case 'inbox':
      return (
        <svg {...common}>
          <path d="M4 5.5h16l1.2 10.2a2 2 0 0 1-2 2.3H4.8a2 2 0 0 1-2-2.3L4 5.5Z" />
          <path d="M3.2 14.5h5l1.3 2h5l1.3-2h5" />
        </svg>
      );
    case 'commitments':
      return (
        <svg {...common}>
          <path d="m5 12.5 4.2 4.2L19.5 6.5" />
          <path d="M20 12v5.3a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 17.3V6.7A1.7 1.7 0 0 1 5.7 5h8.8" />
        </svg>
      );
    case 'integrations':
      return (
        <svg {...common}>
          <path d="M8.5 8.5 5 12l3.5 3.5M15.5 8.5 19 12l-3.5 3.5M14 5l-4 14" />
        </svg>
      );
  }
}

function EmptyState({ copy }: { copy: SectionCopy }) {
  return (
    <div className="app-empty-state">
      <div aria-hidden="true" className="app-empty-art">
        <span className="app-empty-orbit app-empty-orbit-one" />
        <span className="app-empty-orbit app-empty-orbit-two" />
        <span className="app-empty-icon">
          <SectionIcon name={copy.icon} />
        </span>
        <span className="app-empty-spark app-empty-spark-one" />
        <span className="app-empty-spark app-empty-spark-two" />
      </div>
      <p className="app-empty-kicker">{copy.eyebrow}</p>
      <h2>{copy.emptyTitle}</h2>
      <p>{copy.emptyDescription}</p>
    </div>
  );
}

function NoWorkspaceState() {
  return (
    <div className="app-empty-state app-no-workspace-state">
      <div aria-hidden="true" className="app-empty-art">
        <span className="app-empty-orbit app-empty-orbit-one" />
        <span className="app-empty-orbit app-empty-orbit-two" />
        <span className="app-empty-icon app-empty-workspace-icon">
          <svg fill="none" viewBox="0 0 24 24">
            <path
              d="M4 7.2A2.2 2.2 0 0 1 6.2 5h4.3l2 2H18a2 2 0 0 1 2 2v8.8a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 17.8V7.2Z"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
            <path d="M4.5 10h15" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </span>
      </div>
      <p className="app-empty-kicker">Workspace access</p>
      <h2>No workspace available</h2>
      <p>
        Your account is not currently a member of a workspace. Workspace data stays hidden until
        membership is available.
      </p>
    </div>
  );
}

function SettingsPanel({
  name,
  email,
  workspace,
}: {
  name: string;
  email: string;
  workspace: { name: string; role: 'OWNER' | 'MEMBER' } | null;
}) {
  return (
    <div className="settings-panels">
      <section aria-labelledby="account-settings-title" className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-card-icon" aria-hidden="true">
            <span>{name.trim().charAt(0).toLocaleUpperCase() || 'U'}</span>
          </div>
          <div>
            <h2 id="account-settings-title">Account</h2>
            <p>Your signed-in profile.</p>
          </div>
        </div>
        <dl className="settings-details">
          <div>
            <dt>Name</dt>
            <dd>{name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{email}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="workspace-settings-title" className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-card-icon settings-card-icon-workspace" aria-hidden="true">
            <svg fill="none" viewBox="0 0 24 24">
              <path
                d="M4 7.2A2.2 2.2 0 0 1 6.2 5h4.3l2 2H18a2 2 0 0 1 2 2v8.8a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 17.8V7.2Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.6"
              />
              <path d="M4.5 10h15" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </div>
          <div>
            <h2 id="workspace-settings-title">Active workspace</h2>
            <p>Membership is checked by the server on every request.</p>
          </div>
        </div>
        {workspace ? (
          <dl className="settings-details">
            <div>
              <dt>Name</dt>
              <dd>{workspace.name}</dd>
            </div>
            <div>
              <dt>Your role</dt>
              <dd>
                <span className="settings-role-pill">{workspace.role.toLocaleLowerCase()}</span>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="settings-empty-note">There is no active workspace for this account.</p>
        )}
      </section>
    </div>
  );
}

export async function AppSectionPage({
  section,
  searchParams,
}: AppSectionPageProps): Promise<ReactNode> {
  const currentSession = await getAuthenticatedSession(await headers());
  if (!currentSession) {
    redirect('/login');
  }

  const params = await searchParams;
  if (Array.isArray(params.workspaceId)) {
    notFound();
  }

  const workspaces = await listUserWorkspaces(currentSession.user.id);
  const resolution = resolveActiveWorkspace(workspaces, params.workspaceId);
  if (resolution.status === 'not-member') {
    notFound();
  }
  const workspace = resolution.status === 'selected' ? resolution.workspace : null;
  const hasWorkspaceSwitchNotice = params.notice === 'workspace-switched' && workspace !== null;

  const pageTitle = section === 'settings' ? 'Settings' : sectionCopy[section].title;
  const pageDescription =
    section === 'settings'
      ? 'Manage your account and see your workspace access.'
      : sectionCopy[section].description;

  return (
    <section aria-labelledby="app-page-title" className="app-page">
      <header className="app-page-header">
        <div>
          <p className="app-page-eyebrow">{workspace ? workspace.name : 'Your workspace'}</p>
          <h1 id="app-page-title">{pageTitle}</h1>
          <p className="app-page-description">{pageDescription}</p>
        </div>
        {workspace ? (
          <div className="app-page-context">
            <span className="app-context-indicator" />
            <span>{workspace.role === 'OWNER' ? 'Workspace owner' : 'Workspace member'}</span>
          </div>
        ) : null}
      </header>

      {hasWorkspaceSwitchNotice ? (
        <p className="app-success-notice" role="status">
          <span aria-hidden="true" className="app-success-check">
            ✓
          </span>
          Switched to {workspace.name}.
        </p>
      ) : null}

      {section === 'settings' ? (
        <SettingsPanel
          email={currentSession.user.email}
          name={currentSession.user.name}
          workspace={workspace ? { name: workspace.name, role: workspace.role } : null}
        />
      ) : workspace ? (
        <EmptyState copy={sectionCopy[section]} />
      ) : (
        <NoWorkspaceState />
      )}

      <footer className="app-page-footer">
        <span>CommitmentOS</span>
        <span aria-hidden="true">·</span>
        <span>Workspace data is always membership-scoped.</span>
      </footer>
    </section>
  );
}
