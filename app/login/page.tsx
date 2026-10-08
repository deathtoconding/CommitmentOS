import Link from 'next/link';
import { AuthForm } from '@/auth/components/auth-form';

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const emailVerified = params.verified === '1';

  return (
    <main className="auth-shell">
      {emailVerified ? (
        <p className="form-message form-message-success" role="status">
          Your email is verified. Sign in to continue.
        </p>
      ) : null}
      <AuthForm mode="login" />
      <Link className="back-link" href="/">
        Back to CommitmentOS
      </Link>
    </main>
  );
}
