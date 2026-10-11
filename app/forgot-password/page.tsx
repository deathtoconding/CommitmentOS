import Link from 'next/link';
import { PasswordRecoveryForm } from '@/auth/components/password-recovery-form';

export default function ForgotPasswordPage() {
  return (
    <main className="auth-shell">
      <PasswordRecoveryForm mode="request" />
      <Link className="back-link" href="/">
        Back to CommitmentOS
      </Link>
    </main>
  );
}
