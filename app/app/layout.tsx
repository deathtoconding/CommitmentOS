import { Suspense, type ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthenticatedSession } from '@/auth/session';
import { AppShell, AppShellLoadingFallback } from '@/app-shell/app-shell';
import { listUserWorkspaces } from '@/workspaces/queries';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const currentSession = await getAuthenticatedSession(await headers());
  if (!currentSession) {
    redirect('/login');
  }

  const workspaces = await listUserWorkspaces(currentSession.user.id);

  return (
    <Suspense fallback={<AppShellLoadingFallback />}>
      <AppShell
        user={{ name: currentSession.user.name, email: currentSession.user.email }}
        workspaces={workspaces}
      >
        {children}
      </AppShell>
    </Suspense>
  );
}
