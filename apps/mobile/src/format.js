/**
 * A bare YYYY-MM-DD is a calendar date, not an instant, and `new Date()` reads
 * it as UTC midnight - which renders as the day before anywhere west of
 * Greenwich. Postgres hands back every `date` column in that form (licence
 * expiry, time off), so they are rebuilt in local time.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === 'string' && DATE_ONLY.test(d.trim())) {
    const [y, m, day] = d.trim().split('-').map(Number);
    return new Date(y, m - 1, day);
  }
  return new Date(d);
}

const bad = (d) => !d || Number.isNaN(toDate(d).getTime());

export const fmtTime = (d) =>
  bad(d) ? '--' : toDate(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDate = (d) =>
  bad(d) ? '--' : toDate(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtDateShort = (d) =>
  bad(d) ? '--' : toDate(d).toLocaleDateString([], { month: 'short', day: 'numeric' });

export const fmtDateTime = (d) => (bad(d) ? '--' : `${fmtDateShort(d)}, ${fmtTime(d)}`);

export const fmtRange = (a, b) => `${fmtTime(a)} - ${fmtTime(b)}`;

export function fmtDay(d) {
  if (bad(d)) return '--';
  const date = toDate(d);
  const days = Math.round(
    (new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtRelative(d) {
  if (bad(d)) return '--';
  const diff = toDate(d).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  let text;
  if (mins < 1) return 'just now';
  if (mins < 60) text = `${mins}m`;
  else if (mins < 1440) text = `${Math.round(mins / 60)}h`;
  else text = `${Math.round(mins / 1440)}d`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

export function fmtCountdown(seconds) {
  if (seconds == null || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export const fmtMoney = (cents) =>
  cents == null ? '--' : `$${(cents / 100).toFixed(2)}`;
