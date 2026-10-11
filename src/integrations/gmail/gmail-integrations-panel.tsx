import 'server-only';
import { database } from '@/db/client';
import { getGmailOAuthConfigurationState } from './environment';
import { createGmailIntegrationService } from './service-core';
import type { GmailIntegrationStatus } from './model';

const gmailIntegrationService = createGmailIntegrationService(database);

const statusCopy: Record<GmailIntegrationStatus, { label: string; description: string }> = {
  CONNECTED: {
    label: 'Connected',
    description: 'Read-only Gmail access is active for this workspace.',
  },
  REAUTH_REQUIRED: {
    label: 'Reconnect required',
    description: 'The provider no longer accepts this connection. Reconnect to resume access.',
  },
  REVOCATION_PENDING: {
    label: 'Revocation pending',
    description: 'Local processing is paused pending an owner-authorized retry.',
  },
  DISCONNECTED: {
    label: 'Disconnected',
    description: 'The stored credentials have been removed from active use.',
  },
};

const resultCopy: Record<string, { role: 'status' | 'alert'; text: string }> = {
  connected: { role: 'status', text: 'Gmail is connected. No messages were fetched during setup.' },
  error: {
    role: 'alert',
    text: 'Gmail could not be connected. No connection was activated; please try again.',
  },
  disconnected: {
    role: 'status',
    text: 'Gmail is disconnected and its credentials are no longer active.',
  },
  'revocation-pending': {
    role: 'alert',
    text: 'Gmail access is paused locally, but Google has not confirmed revocation. Retry below.',
  },
};

type GmailIntegrationsPanelProps = {
  workspaceId: string;
  role: 'OWNER' | 'MEMBER';
  result?: string;
};

export async function GmailIntegrationsPanel({
  workspaceId,
  role,
  result,
}: GmailIntegrationsPanelProps) {
  let integrations: Awaited<ReturnType<typeof gmailIntegrationService.list>> = [];
  let unavailable = false;
  try {
    integrations = await gmailIntegrationService.list(workspaceId);
  } catch {
    unavailable = true;
  }

  const configuration = getGmailOAuthConfigurationState();
  const message = result ? resultCopy[result] : undefined;
  const canManage = role === 'OWNER';
  const connectHref = `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/gmail/connect`;

  return (
    <section aria-labelledby="gmail-integrations-heading" className="gmail-integration-panel">
      {message ? (
        <p
          className={`gmail-integration-notice gmail-integration-notice-${message.role}`}
          role={message.role}
        >
          {message.text}
        </p>
      ) : null}

      <article className="gmail-integration-card">
        <header className="gmail-integration-card-header">
          <div className="gmail-provider-mark" aria-hidden="true">
            G
          </div>
          <div>
            <p className="gmail-integration-eyebrow">Email provider</p>
            <h2 id="gmail-integrations-heading">Gmail</h2>
          </div>
          {canManage ? (
            configuration === 'ready' ? (
              <a className="gmail-integration-primary" href={connectHref}>
                Connect Gmail
              </a>
            ) : (
              <span className="gmail-integration-disabled-action">Connect unavailable</span>
            )
          ) : null}
        </header>

        <p className="gmail-integration-explanation">
          Connect a Google account with read-only access. Setup stores encrypted OAuth credentials
          and the provider account identity; it does not fetch or retain mail content.
        </p>

        {configuration !== 'ready' && canManage ? (
          <p className="gmail-integration-configuration" role="status">
            {configuration === 'unconfigured'
              ? 'Gmail OAuth is disabled until approved scopes, mailbox-consent rules, and data-handling policy are configured on this server.'
              : 'Gmail OAuth server configuration needs attention.'}
          </p>
        ) : null}
        {!canManage ? (
          <p className="gmail-integration-configuration">
            A workspace owner manages provider connections.
          </p>
        ) : null}

        {unavailable ? (
          <p className="gmail-integration-configuration" role="alert">
            Connection details are temporarily unavailable. Try reloading this page.
          </p>
        ) : integrations.length === 0 ? (
          <p className="gmail-integration-empty">
            No Gmail account is connected to this workspace.
          </p>
        ) : (
          <ul className="gmail-integration-list">
            {integrations.map((integration) => {
              const status = statusCopy[integration.status];
              const disconnectAction = `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/gmail/${encodeURIComponent(integration.id)}/disconnect`;
              return (
                <li className="gmail-integration-account" key={integration.id}>
                  <div className="gmail-integration-account-copy">
                    <div className="gmail-integration-account-heading">
                      <h3>{integration.providerEmail}</h3>
                      <span
                        className={`gmail-integration-status gmail-integration-status-${integration.status.toLowerCase()}`}
                      >
                        {status.label}
                      </span>
                    </div>
                    <p>{status.description}</p>
                    <p className="gmail-integration-scopes">
                      Read-only Gmail and OpenID email identity
                    </p>
                  </div>
                  {canManage && integration.status !== 'DISCONNECTED' ? (
                    <form action={disconnectAction} method="post">
                      <button className="gmail-integration-secondary" type="submit">
                        {integration.status === 'REVOCATION_PENDING'
                          ? 'Retry revocation'
                          : 'Disconnect'}
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </section>
  );
}
