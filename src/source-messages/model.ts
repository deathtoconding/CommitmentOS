export const SOURCE_MESSAGE_PROVIDERS = ['GMAIL', 'SLACK'] as const;

export type SourceMessageProvider = (typeof SOURCE_MESSAGE_PROVIDERS)[number];

/** Provider identities and provider timestamps are optional on migrated opaque legacy references. */
export type SourceMessage = {
  id: string;
  workspaceId: string;
  provider: SourceMessageProvider | null;
  providerAccountId: string | null;
  providerMessageId: string | null;
  providerTimestamp: Date | null;
  legacyReference: string | null;
  createdAt: Date;
};
