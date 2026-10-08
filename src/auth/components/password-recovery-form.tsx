'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { authClient } from '@/auth/client';

type PasswordRecoveryRequestFormProps = {
  mode: 'request';
};

type PasswordRecoveryResetFormProps = {
  mode: 'reset';
  token: string | null;
  invalidLink: boolean;
};

type PasswordRecoveryFormProps = PasswordRecoveryRequestFormProps | PasswordRecoveryResetFormProps;

export function PasswordRecoveryForm(props: PasswordRecoveryFormProps) {
  const resetToken = props.mode === 'reset' ? props.token : null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [passwordUpdated, setPasswordUpdated] = useState(false);
  const [hasInvalidLink, setHasInvalidLink] = useState(
    props.mode === 'reset' && (props.invalidLink || !props.token),
  );

  useEffect(() => {
    if (resetToken) {
      // Keep bearer tokens out of browser history after the page has received them.
      window.history.replaceState(null, '', '/reset-password');
    }
  }, [resetToken]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const formData = new FormData(event.currentTarget);
    setIsSubmitting(true);

    try {
      if (props.mode === 'request') {
        const email = String(formData.get('email') ?? '').trim();
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: '/reset-password',
        });

        if (result.error) {
          setError(
            result.error.status === 429
              ? 'Too many requests. Please wait a little while and try again.'
              : 'We could not process that request. Please try again.',
          );
          return;
        }

        setNotice(
          'If an account exists for that email address, a password reset link will arrive shortly. This page does not confirm whether an account is registered.',
        );
        return;
      }

      const password = String(formData.get('password') ?? '');
      const confirmation = String(formData.get('confirmation') ?? '');
      if (password.length < 12 || password.length > 128) {
        setError('Choose a password between 12 and 128 characters.');
        return;
      }
      if (password !== confirmation) {
        setError('The passwords do not match.');
        return;
      }
      if (!props.token || props.invalidLink) {
        setHasInvalidLink(true);
        return;
      }

      const result = await authClient.resetPassword({
        newPassword: password,
        token: props.token,
      });
      if (result.error) {
        if (result.error.code === 'INVALID_TOKEN') {
          setHasInvalidLink(true);
          return;
        }
        setError('We could not reset your password. Request a new link and try again.');
        return;
      }

      window.history.replaceState(null, '', '/reset-password');
      setPasswordUpdated(true);
    } catch {
      setError(
        props.mode === 'request'
          ? 'We could not process that request. Please try again.'
          : 'We could not reset your password. Request a new link and try again.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (props.mode === 'reset' && (hasInvalidLink || passwordUpdated)) {
    return (
      <div className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          C
        </div>
        <p className="eyebrow">CommitmentOS</p>
        <h1>{passwordUpdated ? 'Password updated' : 'Reset link unavailable'}</h1>
        <p className="auth-intro">
          {passwordUpdated
            ? 'Your password has been changed. Sign in using your new password.'
            : 'This password reset link is invalid, expired, or has already been used. Request a new link to continue.'}
        </p>
        <div className="recovery-actions">
          {passwordUpdated ? (
            <Link className="primary-button button-link" href="/login">
              Go to sign in
            </Link>
          ) : (
            <Link className="primary-button button-link" href="/forgot-password">
              Request a new link
            </Link>
          )}
        </div>
      </div>
    );
  }

  const isReset = props.mode === 'reset';

  return (
    <div className="auth-card">
      <div className="brand-mark" aria-hidden="true">
        C
      </div>
      <p className="eyebrow">CommitmentOS</p>
      <h1>{isReset ? 'Choose a new password' : 'Recover your account'}</h1>
      <p className="auth-intro">
        {isReset
          ? 'Choose a new password for your account. The reset link can only be used once.'
          : 'Enter the email address associated with your account. We will send a reset link if an account matches.'}
      </p>

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        {isReset ? (
          <>
            <label className="field-label" htmlFor="password">
              New password
              <input
                autoComplete="new-password"
                autoFocus
                id="password"
                maxLength={128}
                minLength={12}
                name="password"
                required
                type="password"
              />
              <span className="field-hint">Use at least 12 characters.</span>
            </label>
            <label className="field-label" htmlFor="confirmation">
              Confirm new password
              <input
                autoComplete="new-password"
                id="confirmation"
                maxLength={128}
                minLength={12}
                name="confirmation"
                required
                type="password"
              />
            </label>
          </>
        ) : (
          <label className="field-label" htmlFor="email">
            Email
            <input
              autoComplete="email"
              autoFocus
              id="email"
              maxLength={254}
              name="email"
              required
              type="email"
            />
          </label>
        )}

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
          {isSubmitting ? 'Please wait…' : isReset ? 'Update password' : 'Send reset link'}
        </button>
      </form>

      <p className="auth-switch">
        <Link href="/login">Return to sign in</Link>
      </p>
    </div>
  );
}
