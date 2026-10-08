export default function AppNotFound() {
  return (
    <section className="app-error-page">
      <div aria-hidden="true" className="app-error-symbol app-not-found-symbol">
        404
      </div>
      <p className="app-page-eyebrow">Workspace unavailable</p>
      <h1>This page can’t be found.</h1>
      <p>The workspace may not exist or your membership may have changed.</p>
      <a className="primary-button button-link" href="/app">
        Return to your workspace
      </a>
    </section>
  );
}
