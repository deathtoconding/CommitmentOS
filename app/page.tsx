export default function HomePage() {
  return (
    <main className="page-shell">
      <section aria-labelledby="page-title" className="foundation-card">
        <div className="brand-mark" aria-hidden="true">
          C
        </div>
        <p className="eyebrow">CommitmentOS · MVP foundation</p>
        <h1 id="page-title">Make good on every promise.</h1>
        <p className="intro">
          The application foundation is ready. Commitment workflows will be added in small, testable
          increments.
        </p>
        <div className="status-pill">
          <span className="status-dot" aria-hidden="true" />
          Development environment is running
        </div>
      </section>
    </main>
  );
}
