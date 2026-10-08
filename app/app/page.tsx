import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LogoutButton } from '@/auth/components/logout-button';
import { getAuthenticatedSession } from '@/auth/session';

export default async function AppHomePage() {
  const currentSession = await getAuthenticatedSession(await headers());
  if (!currentSession) {
    redirect('/login');
  }

  return (
    <main className="page-shell">
      <section aria-labelledby="app-title" className="foundation-card app-card">
        <div className="brand-mark" aria-hidden="true">
          C
        </div>
        <p className="eyebrow">Your account</p>
        <h1 id="app-title">You’re signed in.</h1>
        <p className="intro">
          Welcome, {currentSession.user.name}. The workspace experience comes next.
        </p>
        <p className="account-email">{currentSession.user.email}</p>
        <LogoutButton />
      </section>
    </main>
  );
}
