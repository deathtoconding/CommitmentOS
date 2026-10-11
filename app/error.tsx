'use client';

type ApplicationErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ApplicationError({ reset }: ApplicationErrorProps) {
  return (
    <main className="app-error-page app-global-error" role="alert">
      <div aria-hidden="true" className="app-error-symbol">
        !
      </div>
      <p className="app-page-eyebrow">Service unavailable</p>
      <h1>We couldn’t load CommitmentOS.</h1>
      <p>Try again in a moment. No private workspace details are included in this error.</p>
      <button className="primary-button" onClick={reset} type="button">
        Try again
      </button>
    </main>
  );
}
