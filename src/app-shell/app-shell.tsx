'use client';

import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogoutButton } from '@/auth/components/logout-button';
import type { UserWorkspace } from '@/workspaces/queries';

type NavigationItem = {
  href: string;
  label: string;
  icon: 'inbox' | 'commitments' | 'dashboard' | 'integrations' | 'settings';
};

type AppShellProps = {
  children: ReactNode;
  user: { name: string; email: string };
  workspaces: UserWorkspace[];
};

const navigationItems: NavigationItem[] = [
  { href: '/app/inbox', label: 'Inbox', icon: 'inbox' },
  { href: '/app/commitments', label: 'Commitments', icon: 'commitments' },
  { href: '/app', label: 'Dashboard', icon: 'dashboard' },
  { href: '/app/integrations', label: 'Integrations', icon: 'integrations' },
  { href: '/app/settings', label: 'Settings', icon: 'settings' },
];

const sectionNames: Record<string, string> = {
  '/app': 'Dashboard',
  '/app/inbox': 'Inbox',
  '/app/commitments': 'Commitments',
  '/app/integrations': 'Integrations',
  '/app/settings': 'Settings',
};

function AppIcon({ name }: { name: NavigationItem['icon'] }) {
  const shared = {
    'aria-hidden': true as const,
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.7,
    viewBox: '0 0 24 24',
  };

  switch (name) {
    case 'inbox':
      return (
        <svg {...shared}>
          <path d="M4 5.5h16l1.2 10.2a2 2 0 0 1-2 2.3H4.8a2 2 0 0 1-2-2.3L4 5.5Z" />
          <path d="M3.2 14.5h5l1.3 2h5l1.3-2h5" />
        </svg>
      );
    case 'commitments':
      return (
        <svg {...shared}>
          <path d="m5 12.5 4.2 4.2L19.5 6.5" />
          <path d="M20 12v5.3a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 17.3V6.7A1.7 1.7 0 0 1 5.7 5h8.8" />
        </svg>
      );
    case 'dashboard':
      return (
        <svg {...shared}>
          <rect height="7" rx="1.5" width="7" x="3.5" y="3.5" />
          <rect height="11" rx="1.5" width="7" x="13.5" y="3.5" />
          <rect height="7" rx="1.5" width="7" x="3.5" y="13.5" />
          <rect height="7" rx="1.5" width="7" x="13.5" y="13.5" />
        </svg>
      );
    case 'integrations':
      return (
        <svg {...shared}>
          <path d="M8.5 8.5 5 12l3.5 3.5M15.5 8.5 19 12l-3.5 3.5M14 5l-4 14" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...shared}>
          <circle cx="12" cy="12" r="3" />
          <path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 0 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-.9-3h-.2a1.8 1.8 0 0 1 0-3.6h.2a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 0 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 0 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-.9 3Z" />
        </svg>
      );
  }
}

function initialsFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? '')
    .join('');
}

function addWorkspaceQuery(path: string, workspaceId: string | undefined): string {
  if (!workspaceId) return path;
  const query = new URLSearchParams({ workspaceId });
  return `${path}?${query.toString()}`;
}

export function AppShell({ children, user, workspaces }: AppShellProps) {
  const pathname = usePathname() ?? '/app';
  const searchParams = useSearchParams();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  useEffect(() => {
    function reloadRestoredAppPage(event: PageTransitionEvent) {
      if (event.persisted) {
        window.location.reload();
      }
    }

    window.addEventListener('pageshow', reloadRestoredAppPage);
    return () => window.removeEventListener('pageshow', reloadRestoredAppPage);
  }, []);

  const workspaceQuery = searchParams.getAll('workspaceId');
  const hasAmbiguousWorkspaceSelection = workspaceQuery.length > 1;
  const requestedWorkspaceId = workspaceQuery.length === 1 ? workspaceQuery[0] : undefined;
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === requestedWorkspaceId);
  const activeWorkspace = hasAmbiguousWorkspaceSelection
    ? undefined
    : requestedWorkspaceId === undefined
      ? workspaces[0]
      : selectedWorkspace;
  const noticeValues = searchParams.getAll('notice');
  const workspaceSwitchSuccessMessage =
    noticeValues.length === 1 && noticeValues[0] === 'workspace-switched' && activeWorkspace
      ? `Switched to ${activeWorkspace.name}.`
      : null;
  const activeSection = sectionNames[pathname] ?? 'Workspace';

  function selectWorkspace(nextWorkspaceId: string) {
    if (!workspaces.some((workspace) => workspace.id === nextWorkspaceId)) return;
    if (nextWorkspaceId === activeWorkspace?.id) return;

    const query = new URLSearchParams({
      workspaceId: nextWorkspaceId,
      notice: 'workspace-switched',
    });
    window.location.assign(`${pathname}?${query.toString()}`);
  }

  return (
    <div className="app-frame">
      {mobileNavigationOpen ? (
        <button
          aria-label="Close navigation"
          className="app-mobile-scrim"
          onClick={() => setMobileNavigationOpen(false)}
          type="button"
        />
      ) : null}

      <aside
        aria-label="Application navigation"
        className={`app-sidebar${mobileNavigationOpen ? ' app-sidebar-open' : ''}`}
      >
        <a
          aria-label="CommitmentOS home"
          className="app-brand"
          href={addWorkspaceQuery('/app', activeWorkspace?.id)}
        >
          <span aria-hidden="true" className="app-brand-mark">
            C
          </span>
          <span className="app-brand-copy">
            <strong>CommitmentOS</strong>
            <span>Make good on every promise</span>
          </span>
        </a>

        <div className="app-sidebar-label">Workspace</div>
        <nav aria-label="Primary" className="app-navigation" id="app-primary-navigation">
          {navigationItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <a
                aria-current={isActive ? 'page' : undefined}
                className={`app-nav-link${isActive ? ' app-nav-link-active' : ''}`}
                href={addWorkspaceQuery(item.href, activeWorkspace?.id)}
                key={item.href}
                onClick={() => setMobileNavigationOpen(false)}
              >
                <AppIcon name={item.icon} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div aria-label="Privacy note" className="app-sidebar-footnote">
          <span aria-hidden="true" className="app-shield-icon">
            <svg fill="none" viewBox="0 0 20 20">
              <path
                d="M10 2.5 16 5v4.4c0 3.7-2.5 6.4-6 8.1-3.5-1.7-6-4.4-6-8.1V5l6-2.5Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.4"
              />
              <path
                d="m7.5 9.8 1.6 1.6 3.5-3.7"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
              />
            </svg>
          </span>
          <span>
            <strong>Private by workspace</strong>
            <small>Only your memberships are shown.</small>
          </span>
        </div>
      </aside>

      <main className="app-main">
        <header className="app-topbar">
          <div className="app-topbar-left">
            <button
              aria-controls="app-primary-navigation"
              aria-expanded={mobileNavigationOpen}
              aria-label={mobileNavigationOpen ? 'Close navigation' : 'Open navigation'}
              className="app-menu-button"
              onClick={() => setMobileNavigationOpen((open) => !open)}
              type="button"
            >
              <span />
              <span />
              <span />
            </button>
            <div className="app-breadcrumb">
              <span>Workspace</span>
              <span aria-hidden="true" className="app-breadcrumb-divider">
                /
              </span>
              <strong>{activeSection}</strong>
            </div>
          </div>

          <div className="app-topbar-actions">
            <label className="workspace-switcher">
              <span className="workspace-switcher-label">Active workspace</span>
              <span className="workspace-select-wrap">
                <span aria-hidden="true" className="workspace-select-mark">
                  {activeWorkspace?.name.slice(0, 1).toLocaleUpperCase() ?? '—'}
                </span>
                <select
                  aria-label="Active workspace"
                  disabled={workspaces.length === 0}
                  onChange={(event) => selectWorkspace(event.currentTarget.value)}
                  value={activeWorkspace?.id ?? ''}
                >
                  {workspaces.length === 0 ? (
                    <option value="">No workspace available</option>
                  ) : null}
                  {workspaces.length > 0 && !activeWorkspace ? (
                    <option disabled value="">
                      Choose a workspace
                    </option>
                  ) : null}
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
                <span aria-hidden="true" className="workspace-select-chevron">
                  ▾
                </span>
              </span>
            </label>

            <details className="app-user-menu">
              <summary aria-label={`Account menu for ${user.name}`}>
                <span aria-hidden="true" className="app-avatar">
                  {initialsFor(user.name) || 'U'}
                </span>
                <span className="app-user-summary">
                  <strong>{user.name}</strong>
                  <small>Account</small>
                </span>
                <span aria-hidden="true" className="app-user-chevron">
                  ▾
                </span>
              </summary>
              <div className="app-user-dropdown">
                <div className="app-user-card">
                  <strong>{user.name}</strong>
                  <span>{user.email}</span>
                </div>
                <a href={addWorkspaceQuery('/app/settings', activeWorkspace?.id)}>
                  Account settings
                </a>
                <div className="app-user-divider" />
                <LogoutButton />
              </div>
            </details>
          </div>
        </header>

        <div className="app-content">
          {workspaceSwitchSuccessMessage ? (
            <p className="app-success-notice" role="status">
              <span aria-hidden="true" className="app-success-check">
                ✓
              </span>
              {workspaceSwitchSuccessMessage}
            </p>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}

export function AppShellLoadingFallback() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading application shell"
      className="app-frame app-frame-loading"
    >
      <aside className="app-sidebar app-sidebar-loading">
        <div className="app-loading-block app-loading-brand" />
        <div className="app-loading-block app-loading-nav" />
        <div className="app-loading-block app-loading-nav" />
        <div className="app-loading-block app-loading-nav" />
      </aside>
      <main className="app-main">
        <div className="app-loading-topbar">
          <span className="app-loading-block" />
          <span className="app-loading-block" />
        </div>
        <p className="app-loading-label" role="status">
          Loading your workspace…
        </p>
      </main>
    </div>
  );
}
