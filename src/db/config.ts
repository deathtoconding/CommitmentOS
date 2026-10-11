const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

export function getDatabaseUrl(value: string | undefined = process.env.DATABASE_URL): string {
  if (!value?.trim()) {
    throw new Error('DATABASE_URL is required for database operations.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!POSTGRES_PROTOCOLS.has(parsed.protocol) || parsed.pathname.length < 2) {
    throw new Error(
      'DATABASE_URL must use postgres:// or postgresql:// and include a database name.',
    );
  }

  return value;
}
