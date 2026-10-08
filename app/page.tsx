import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="page-shell">
      <section aria-labelledby="page-title" className="foundation-card">
        <div className="brand-mark" aria-hidden="true">
          C
        </div>
        <p className="eyebrow">CommitmentOS</p>
        <h1 id="page-title">Make good on every promise.</h1>
        <p className="intro">
          A clear view of what your team promised, who owns it, and what needs attention next.
        </p>
        <div className="home-actions">
          <Link className="primary-button button-link" href="/signup">
            Create an account
          </Link>
          <Link className="text-link" href="/login">
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
