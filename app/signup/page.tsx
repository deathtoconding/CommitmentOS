import Link from 'next/link';
import { AuthForm } from '@/auth/components/auth-form';

export default function SignupPage() {
  return (
    <main className="auth-shell">
      <AuthForm mode="signup" />
      <Link className="back-link" href="/">
        Back to CommitmentOS
      </Link>
    </main>
  );
}
