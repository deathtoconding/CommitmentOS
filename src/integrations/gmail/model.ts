export const GMAIL_INTEGRATION_STATUSES = [
  'CONNECTED',
  'REAUTH_REQUIRED',
  'REVOCATION_PENDING',
  'DISCONNECTED',
] as const;

export type GmailIntegrationStatus = (typeof GMAIL_INTEGRATION_STATUSES)[number];

/** The connection requests only identity email and read-only Gmail access. */
export const GMAIL_REQUIRED_SCOPES = [
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
] as const;

export const GMAIL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const GMAIL_PROVIDER_TIMEOUT_MS = 10_000;

export type GmailStoredCredentials = {
  accessToken: string;
  refreshToken: string;
};

export type GmailIntegrationSummary = {
  id: string;
  providerEmail: string;
  status: GmailIntegrationStatus;
  scopes: string[];
  accessTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const GMAIL_INTEGRATION_AUDIT_EVENT_TYPES = [
  'CONNECTED',
  'REVOCATION_REQUESTED',
  'REVOCATION_ATTEMPT_FAILED',
  'DISCONNECTED',
] as const;

export type GmailIntegrationAuditEventType = (typeof GMAIL_INTEGRATION_AUDIT_EVENT_TYPES)[number];
