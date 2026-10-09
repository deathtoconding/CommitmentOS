import { describe, expect, it } from 'vitest';
import { SOURCE_MESSAGE_PROVIDERS } from './model';
import { sourceMessageIdentitySchema } from './schemas';

describe('sourceMessageIdentitySchema', () => {
  it('validates provider identity without changing opaque, case-sensitive identifiers', () => {
    const result = sourceMessageIdentitySchema.parse({
      provider: 'GMAIL',
      providerAccountId: 'Account:Case-Sensitive_17',
      providerMessageId: 'Msg/AbC-001',
      providerTimestamp: '2026-10-08T14:30:00+02:00',
    });

    expect(result).toEqual({
      provider: 'GMAIL',
      providerAccountId: 'Account:Case-Sensitive_17',
      providerMessageId: 'Msg/AbC-001',
      providerTimestamp: new Date('2026-10-08T12:30:00.000Z'),
    });
  });

  it('keeps unknown provider timestamps null instead of inventing a time', () => {
    expect(
      sourceMessageIdentitySchema.parse({
        provider: 'SLACK',
        providerAccountId: 'workspace-subject-9',
        providerMessageId: '1712345678.012300',
      }),
    ).toEqual({
      provider: 'SLACK',
      providerAccountId: 'workspace-subject-9',
      providerMessageId: '1712345678.012300',
      providerTimestamp: null,
    });
    expect(
      sourceMessageIdentitySchema.parse({
        provider: 'SLACK',
        providerAccountId: 'workspace-subject-9',
        providerMessageId: '1712345678.012300',
        providerTimestamp: null,
      }).providerTimestamp,
    ).toBeNull();
  });

  it('accepts only the explicitly supported provider identifiers', () => {
    expect(SOURCE_MESSAGE_PROVIDERS).toEqual(['GMAIL', 'SLACK']);
    expect(
      sourceMessageIdentitySchema.safeParse({
        provider: 'CALENDAR',
        providerAccountId: 'account-1',
        providerMessageId: 'message-1',
      }).success,
    ).toBe(false);
  });

  it('rejects empty, padded, overlong, and control-character identifiers without normalizing them', () => {
    for (const providerMessageId of ['', '   ', ' message-1', 'message-1 ', 'message\n1']) {
      expect(
        sourceMessageIdentitySchema.safeParse({
          provider: 'GMAIL',
          providerAccountId: 'account-1',
          providerMessageId,
        }).success,
      ).toBe(false);
    }

    expect(
      sourceMessageIdentitySchema.safeParse({
        provider: 'GMAIL',
        providerAccountId: 'x'.repeat(1_025),
        providerMessageId: 'message-1',
      }).success,
    ).toBe(false);
    expect(
      sourceMessageIdentitySchema.safeParse({
        provider: 'GMAIL',
        providerAccountId: 'account-1',
        providerMessageId: 'x'.repeat(2_049),
      }).success,
    ).toBe(false);
  });

  it('rejects malformed timestamps and content fields rather than silently storing them', () => {
    expect(
      sourceMessageIdentitySchema.safeParse({
        provider: 'GMAIL',
        providerAccountId: 'account-1',
        providerMessageId: 'message-1',
        providerTimestamp: 'unknown local time',
      }).success,
    ).toBe(false);
    expect(
      sourceMessageIdentitySchema.safeParse({
        provider: 'GMAIL',
        providerAccountId: 'account-1',
        providerMessageId: 'message-1',
        body: 'message text must not be persisted by this model',
      }).success,
    ).toBe(false);
  });
});
