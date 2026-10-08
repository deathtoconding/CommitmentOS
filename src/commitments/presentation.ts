import type { CommitmentStatus } from './model';

const dateOptions: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  timeZoneName: 'short',
  year: 'numeric',
};

export function formatCommitmentDeadline(dueAt: Date | null, dueTimezone: string | null): string {
  if (dueAt === null || Number.isNaN(dueAt.getTime())) return 'No deadline set';

  const timeZone = dueTimezone?.trim() || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', { ...dateOptions, timeZone }).format(dueAt);
  } catch {
    // Preserve the absolute instant if a stored timezone is malformed; never guess a local zone.
    return new Intl.DateTimeFormat('en-GB', { ...dateOptions, timeZone: 'UTC' }).format(dueAt);
  }
}

export function commitmentStatusLabel(status: CommitmentStatus): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
