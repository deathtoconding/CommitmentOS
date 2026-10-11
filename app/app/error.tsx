'use client';

type AppErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function AppError({ reset }: AppErrorProps) {
  return (
    <section className="app-error-page" role="alert">
      <div aria-hidden="true" className="app-error-symbol">
        !
      </div>
      <p className="app-page-eyebrow">Something went wrong</p>
      <h1>We couldn’t load this workspace.</h1>
      <p>Your session and workspace data remain protected. Try loading the page again.</p>
      <button className="primary-button" onClick={reset} type="button">
        Try again
      </button>
    </section>
  );
}
