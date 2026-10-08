import { describe, expect, it } from 'vitest';
import { loginSchema, registrationSchema } from './schemas';

describe('authentication input schemas', () => {
  it('normalizes valid registration fields', () => {
    expect(
      registrationSchema.parse({
        name: '  Alex Morgan  ',
        email: '  ALEX@example.com ',
        password: 'a-long-enough-test-password',
      }),
    ).toEqual({
      name: 'Alex Morgan',
      email: 'alex@example.com',
      password: 'a-long-enough-test-password',
    });
  });

  it('rejects short passwords, oversized names, and unknown fields', () => {
    expect(
      registrationSchema.safeParse({
        name: 'Alex',
        email: 'alex@example.com',
        password: 'short',
      }).success,
    ).toBe(false);
    expect(
      registrationSchema.safeParse({
        name: 'x'.repeat(81),
        email: 'alex@example.com',
        password: 'a-long-enough-test-password',
      }).success,
    ).toBe(false);
    expect(
      registrationSchema.safeParse({
        name: 'Alex',
        email: 'alex@example.com',
        password: 'a-long-enough-test-password',
        admin: true,
      }).success,
    ).toBe(false);
  });

  it('accepts sign-in input and rejects invalid addresses or empty passwords', () => {
    expect(
      loginSchema.safeParse({ email: 'alex@example.com', password: 'not-the-password' }).success,
    ).toBe(true);
    expect(loginSchema.safeParse({ email: 'invalid', password: 'something' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'alex@example.com', password: '' }).success).toBe(false);
  });
});
