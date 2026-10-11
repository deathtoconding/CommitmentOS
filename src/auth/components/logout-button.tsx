'use client';

import { useState } from 'react';
import { authClient } from '@/auth/client';

export function LogoutButton() {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function signOut() {
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError('Could not sign out. Please try again.');
        return;
      }

      window.location.replace('/login');
    } catch {
      setError('Could not sign out. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div aria-busy={isSubmitting} className="logout-actions">
      <button className="secondary-button" disabled={isSubmitting} onClick={signOut} type="button">
        {isSubmitting ? 'Signing out…' : 'Sign out'}
      </button>
      {error ? (
        <p className="form-message form-message-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
