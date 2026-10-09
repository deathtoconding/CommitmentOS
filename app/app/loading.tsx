export default function AppLoading() {
  return (
    <section aria-busy="true" aria-label="Loading workspace" className="app-loading-page">
      <div className="app-loading-heading">
        <span className="app-loading-block app-loading-eyebrow" />
        <span className="app-loading-block app-loading-title" />
        <span className="app-loading-block app-loading-description" />
      </div>
      <div className="app-loading-content">
        <span className="app-loading-block app-loading-artifact" />
        <span className="app-loading-block app-loading-line" />
        <span className="app-loading-block app-loading-line app-loading-line-short" />
      </div>
      <p className="app-loading-label" role="status">
        Loading your workspace…
      </p>
    </section>
  );
}
