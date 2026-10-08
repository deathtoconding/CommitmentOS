import Link from 'next/link';
import { AuthForm } from '@/auth/components/auth-form';

export default function LoginPage() {
  return (
    <main className="auth-shell">
      <AuthForm mode="login" />
      <Link className="back-link" href="/">
        Back to CommitmentOS
      </Link>
    </main>
  );
}
