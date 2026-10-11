'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { authClient } from '@/auth/client';
import { loginSchema, registrationSchema } from '@/auth/schemas';

type AuthFormProps = {
  mode: 'login' | 'signup';
};

export function AuthForm({ mode }: AuthFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSignup = mode === 'signup';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');

    if (isSignup) {
      const parsed = registrationSchema.safeParse({
        name: String(formData.get('name') ?? ''),
        email,
        password,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Please check the information and try again.');
        return;
      }

      setIsSubmitting(true);
      try {
        const result = await authClient.signUp.email({
          ...parsed.data,
          callbackURL: '/login?verified=1',
        });
        if (result.error) {
          setError('We could not process registration. Please check the details and try again.');
          return;
        }

        setNotice(
          'If this email address is available, check its inbox for a verification link before signing in.',
        );
      } catch {
        setError('Authentication is temporarily unavailable. Please try again.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the information and try again.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await authClient.signIn.email({
        ...parsed.data,
        callbackURL: '/login?verified=1',
      });
      if (result.error) {
        setError(
          result.error.code === 'EMAIL_NOT_VERIFIED'
            ? 'Verify your email address before signing in. A verification link has been sent if this address is registered.'
            : 'Sign-in failed. Check your email and password, then try again.',
        );
        return;
      }

      window.location.replace('/app');
    } catch {
      setError('Authentication is temporarily unavailable. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="brand-mark" aria-hidden="true">
        C
      </div>
      <p className="eyebrow">CommitmentOS</p>
      <h1>{isSignup ? 'Create your account' : 'Welcome back'}</h1>
      <p className="auth-intro">
        {isSignup
          ? 'Start by setting up your personal sign-in. Workspace setup comes next.'
          : 'Sign in to continue to your workspace.'}
      </p>

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        {isSignup ? (
          <label className="field-label" htmlFor="name">
            Name
            <input
              autoComplete="name"
              autoFocus
              id="name"
              maxLength={80}
              name="name"
              required
              type="text"
            />
          </label>
        ) : null}

        <label className="field-label" htmlFor="email">
          Email
          <input
            autoComplete="email"
            autoFocus={!isSignup}
            id="email"
            maxLength={254}
            name="email"
            required
            type="email"
          />
        </label>

        <label className="field-label" htmlFor="password">
          Password
          <input
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            id="password"
            maxLength={128}
            minLength={isSignup ? 12 : 1}
            name="password"
            required
            type="password"
          />
          {isSignup ? <span className="field-hint">Use at least 12 characters.</span> : null}
        </label>

        {error ? (
          <p className="form-message form-message-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="form-message form-message-success" role="status">
            {notice}
          </p>
        ) : null}

        <button className="primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <p className="auth-switch">
        {isSignup ? 'Already have an account?' : 'New to CommitmentOS?'}{' '}
        <Link href={isSignup ? '/login' : '/signup'}>
          {isSignup ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </div>
  );
}
