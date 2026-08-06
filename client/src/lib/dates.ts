/**
 * DUE_AT is a DATETIME column holding a calendar date at midnight UTC — the
 * lend form submits a date-only string, and the server pool runs at +00:00.
 * Rendering that instant through local time shows the previous day anywhere
 * west of UTC (Aug 10 becomes "due 8/9"), so every surface must treat it as
 * a calendar date, never as a moment in time.
 */

/** Display the stored calendar date regardless of the viewer's timezone. */
export function formatDueDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC' });
}

/**
 * Whole calendar days a loan is overdue: the stored (UTC) due date versus
 * today's local calendar date. 0 = due today; negative = not due yet.
 */
export function daysOverdue(iso: string, now: Date = new Date()): number {
  const due = new Date(iso);
  const dueUtc = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((todayUtc - dueUtc) / 86_400_000);
}
