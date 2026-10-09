import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { gmailIntegration, gmailIntegrationAuditEvent, gmailOAuthState } from '../../db/schema';
import { decryptIntegrationSecret, encryptIntegrationSecret } from '../secret-crypto';
import type { GmailIntegrationSummary, GmailStoredCredentials } from './model';
import { GMAIL_REQUIRED_SCOPES, GMAIL_OAUTH_STATE_TTL_MS } from './model';

const storedCredentialsSchema = z
  .object({
    accessToken: z.string().min(1).max(8192),
    refreshToken: z.string().min(1).max(8192),
  })
  .strict();

export class GmailIntegrationBusyError extends Error {
  constructor() {
    super('This Gmail account has a pending revocation and cannot be reconnected yet.');
    this.name = 'GmailIntegrationBusyError';
  }
}

export class GmailRefreshTokenMissingError extends Error {
  constructor() {
    super('A refresh token is required to keep the Gmail connection available.');
    this.name = 'GmailRefreshTokenMissingError';
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gmailOAuthStateAad(stateHash: string): string {
  return `commitmentos:gmail-oauth-state:${stateHash}`;
}

function gmailIntegrationAad(workspaceId: string, providerAccountId: string): string {
  return `commitmentos:gmail-integration:${workspaceId}:${providerAccountId}`;
}

export function parseGmailStoredCredentials(
  serialized: string,
  encryptionKey: Buffer,
  associatedData: string,
): GmailStoredCredentials {
  let value: unknown;
  try {
    value = JSON.parse(decryptIntegrationSecret(serialized, encryptionKey, associatedData));
  } catch {
    throw new Error('Gmail credentials could not be decrypted.');
  }
  const credentials = storedCredentialsSchema.safeParse(value);
  if (!credentials.success) throw new Error('Stored Gmail credentials are invalid.');
  return credentials.data;
}

export function createGmailOAuthStateStore<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
) {
  return {
    async create(input: {
      workspaceId: string;
      userId: string;
      state: string;
      browserToken: string;
      nonce: string;
      codeVerifier: string;
      encryptionKey: Buffer;
      now?: Date;
    }): Promise<void> {
      if (
        !/^[A-Za-z0-9_-]{32,128}$/.test(input.state) ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(input.browserToken) ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce) ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeVerifier)
      ) {
        throw new TypeError('Gmail OAuth state values have an invalid format.');
      }

      const now = input.now ?? new Date();
      const stateHash = hash(input.state);
      const oidcNonceHash = hash(input.nonce);
      const codeVerifierCiphertext = encryptIntegrationSecret(
        input.codeVerifier,
        input.encryptionKey,
        gmailOAuthStateAad(stateHash),
      );
      await database.delete(gmailOAuthState).where(lte(gmailOAuthState.expiresAt, now));
      await database
        .insert(gmailOAuthState)
        .values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          userId: input.userId,
          stateHash,
          browserTokenHash: hash(input.browserToken),
          oidcNonceHash,
          codeVerifierCiphertext,
          expiresAt: new Date(now.getTime() + GMAIL_OAUTH_STATE_TTL_MS),
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [gmailOAuthState.workspaceId, gmailOAuthState.userId],
          set: {
            stateHash,
            browserTokenHash: hash(input.browserToken),
            oidcNonceHash,
            codeVerifierCiphertext,
            expiresAt: new Date(now.getTime() + GMAIL_OAUTH_STATE_TTL_MS),
            createdAt: now,
          },
        });
    },

    async consume(input: { state: string; browserToken: string; now?: Date }): Promise<{
      workspaceId: string;
      userId: string;
      stateHash: string;
      oidcNonceHash: string;
      codeVerifierCiphertext: string;
    } | null> {
      const now = input.now ?? new Date();
      const [consumed] = await database
        .delete(gmailOAuthState)
        .where(
          and(
            eq(gmailOAuthState.stateHash, hash(input.state)),
            eq(gmailOAuthState.browserTokenHash, hash(input.browserToken)),
            gt(gmailOAuthState.expiresAt, now),
          ),
        )
        .returning({
          workspaceId: gmailOAuthState.workspaceId,
          userId: gmailOAuthState.userId,
          stateHash: gmailOAuthState.stateHash,
          oidcNonceHash: gmailOAuthState.oidcNonceHash,
          codeVerifierCiphertext: gmailOAuthState.codeVerifierCiphertext,
        });
      return consumed ?? null;
    },
  };
}

export function createGmailIntegrationService<TSchema extends Record<string, unknown>>(
  database: NodePgDatabase<TSchema>,
) {
  return {
    async list(workspaceId: string): Promise<GmailIntegrationSummary[]> {
      const rows = await database
        .select({
          id: gmailIntegration.id,
          providerEmail: gmailIntegration.providerEmail,
          status: gmailIntegration.status,
          scopes: gmailIntegration.scopes,
          accessTokenExpiresAt: gmailIntegration.accessTokenExpiresAt,
          createdAt: gmailIntegration.createdAt,
          updatedAt: gmailIntegration.updatedAt,
        })
        .from(gmailIntegration)
        .where(eq(gmailIntegration.workspaceId, workspaceId))
        .orderBy(gmailIntegration.createdAt, gmailIntegration.id);
      return rows.map((row) => ({ ...row, scopes: row.scopes.split(' ').filter(Boolean) }));
    },

    async connect(input: {
      workspaceId: string;
      actorUserId: string;
      providerAccountId: string;
      providerEmail: string;
      scopes: readonly string[];
      accessToken: string;
      refreshToken: string | undefined;
      accessTokenExpiresAt: Date;
      encryptionKey: Buffer;
    }): Promise<{ integrationId: string }> {
      if (
        input.scopes.length !== GMAIL_REQUIRED_SCOPES.length ||
        [...input.scopes]
          .sort()
          .some((scope, index) => scope !== [...GMAIL_REQUIRED_SCOPES].sort()[index])
      ) {
        throw new TypeError('Gmail connection scopes are invalid.');
      }

      return database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(gmailIntegration)
          .where(
            and(
              eq(gmailIntegration.workspaceId, input.workspaceId),
              eq(gmailIntegration.providerAccountId, input.providerAccountId),
            ),
          )
          .limit(1)
          .for('update');

        if (existing?.status === 'REVOCATION_PENDING') throw new GmailIntegrationBusyError();

        let refreshToken = input.refreshToken;
        if (!refreshToken && existing?.status === 'CONNECTED' && existing.credentialsCiphertext) {
          refreshToken = parseGmailStoredCredentials(
            existing.credentialsCiphertext,
            input.encryptionKey,
            gmailIntegrationAad(input.workspaceId, input.providerAccountId),
          ).refreshToken;
        }
        if (!refreshToken) throw new GmailRefreshTokenMissingError();

        const credentials: GmailStoredCredentials = {
          accessToken: input.accessToken,
          refreshToken,
        };
        const encryptedCredentials = encryptIntegrationSecret(
          JSON.stringify(credentials),
          input.encryptionKey,
          gmailIntegrationAad(input.workspaceId, input.providerAccountId),
        );
        const now = new Date();
        const [saved] = await transaction
          .insert(gmailIntegration)
          .values({
            id: randomUUID(),
            workspaceId: input.workspaceId,
            providerAccountId: input.providerAccountId,
            providerEmail: input.providerEmail,
            status: 'CONNECTED',
            scopes: [...input.scopes].sort().join(' '),
            credentialsCiphertext: encryptedCredentials,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            createdByUserId: input.actorUserId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [gmailIntegration.workspaceId, gmailIntegration.providerAccountId],
            set: {
              providerEmail: input.providerEmail,
              status: 'CONNECTED',
              scopes: [...input.scopes].sort().join(' '),
              credentialsCiphertext: encryptedCredentials,
              accessTokenExpiresAt: input.accessTokenExpiresAt,
              updatedAt: now,
            },
          })
          .returning({ id: gmailIntegration.id });

        if (!saved) throw new Error('Gmail integration could not be saved.');
        await transaction.insert(gmailIntegrationAuditEvent).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          integrationId: saved.id,
          actorUserId: input.actorUserId,
          eventType: 'CONNECTED',
          details: { provider: 'GMAIL', status: 'CONNECTED' },
        });
        return { integrationId: saved.id };
      });
    },

    async beginRevocation(input: {
      workspaceId: string;
      integrationId: string;
      actorUserId: string;
    }): Promise<{
      status: 'not-found' | 'disconnected' | 'pending';
      credentialsCiphertext?: string;
      providerAccountId?: string;
    }> {
      return database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(gmailIntegration)
          .where(
            and(
              eq(gmailIntegration.workspaceId, input.workspaceId),
              eq(gmailIntegration.id, input.integrationId),
            ),
          )
          .limit(1)
          .for('update');
        if (!existing) return { status: 'not-found' };
        if (existing.status === 'DISCONNECTED') return { status: 'disconnected' };
        if (!existing.credentialsCiphertext) {
          throw new Error('Active Gmail connection has no encrypted credentials.');
        }

        if (existing.status !== 'REVOCATION_PENDING') {
          await transaction
            .update(gmailIntegration)
            .set({ status: 'REVOCATION_PENDING', updatedAt: new Date() })
            .where(eq(gmailIntegration.id, existing.id));
          await transaction.insert(gmailIntegrationAuditEvent).values({
            id: randomUUID(),
            workspaceId: existing.workspaceId,
            integrationId: existing.id,
            actorUserId: input.actorUserId,
            eventType: 'REVOCATION_REQUESTED',
            details: { provider: 'GMAIL', status: 'REVOCATION_PENDING' },
          });
        }
        return {
          status: 'pending',
          credentialsCiphertext: existing.credentialsCiphertext,
          providerAccountId: existing.providerAccountId,
        };
      });
    },

    async failRevocation(input: {
      workspaceId: string;
      integrationId: string;
      actorUserId: string;
    }): Promise<void> {
      await database.transaction(async (transaction) => {
        const [pending] = await transaction
          .select({ id: gmailIntegration.id })
          .from(gmailIntegration)
          .where(
            and(
              eq(gmailIntegration.workspaceId, input.workspaceId),
              eq(gmailIntegration.id, input.integrationId),
              eq(gmailIntegration.status, 'REVOCATION_PENDING'),
            ),
          )
          .limit(1)
          .for('update');
        if (!pending) return;

        await transaction.insert(gmailIntegrationAuditEvent).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          actorUserId: input.actorUserId,
          eventType: 'REVOCATION_ATTEMPT_FAILED',
          details: { provider: 'GMAIL', status: 'REVOCATION_PENDING' },
        });
      });
    },

    async completeRevocation(input: {
      workspaceId: string;
      integrationId: string;
      actorUserId: string;
    }): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(gmailIntegration)
          .set({
            status: 'DISCONNECTED',
            credentialsCiphertext: null,
            accessTokenExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(gmailIntegration.workspaceId, input.workspaceId),
              eq(gmailIntegration.id, input.integrationId),
              eq(gmailIntegration.status, 'REVOCATION_PENDING'),
            ),
          )
          .returning({ id: gmailIntegration.id });
        if (!updated) return false;
        await transaction.insert(gmailIntegrationAuditEvent).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          actorUserId: input.actorUserId,
          eventType: 'DISCONNECTED',
          details: { provider: 'GMAIL', status: 'DISCONNECTED' },
        });
        return true;
      });
    },
  };
}
