import Link from 'next/link';
import { PasswordRecoveryForm } from '@/auth/components/password-recovery-form';

type ResetPasswordPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : null;
  const invalidLink = params.error === 'INVALID_TOKEN';

  return (
    <main className="auth-shell">
      <PasswordRecoveryForm mode="reset" token={token} invalidLink={invalidLink} />
      <Link className="back-link" href="/">
        Back to CommitmentOS
      </Link>
    </main>
  );
}
