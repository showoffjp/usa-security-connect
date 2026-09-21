/** Display helpers. Everything renders in the browser's local timezone. */

const invalid = (d) => !d || Number.isNaN(new Date(d).getTime());

export const fmtTime = (d) =>
  invalid(d) ? '--' : new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDate = (d) =>
  invalid(d) ? '--' : new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtDateShort = (d) =>
  invalid(d) ? '--' : new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });

export const fmtDateTime = (d) => (invalid(d) ? '--' : `${fmtDateShort(d)}, ${fmtTime(d)}`);

export const fmtWeekday = (d) =>
  invalid(d) ? '--' : new Date(d).toLocaleDateString([], { weekday: 'short' });

/** "Today", "Tomorrow", "Yesterday", or a short date. */
export function fmtDay(d) {
  if (invalid(d)) return '--';
  const date = new Date(d);
  const today = new Date();
  const days = Math.round(
    (new Date(date).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86400000
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "in 12m", "3h ago". */
export function fmtRelative(d) {
  if (invalid(d)) return '--';
  const diff = new Date(d).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const ahead = diff > 0;
  let text;
  if (mins < 1) text = 'just now';
  else if (mins < 60) text = `${mins}m`;
  else if (mins < 1440) text = `${Math.round(mins / 60)}h`;
  else text = `${Math.round(mins / 1440)}d`;
  if (text === 'just now') return text;
  return ahead ? `in ${text}` : `${text} ago`;
}

export const fmtRange = (a, b) => `${fmtTime(a)} - ${fmtTime(b)}`;

export const fmtHours = (h) => (h == null ? '--' : `${Number(h).toFixed(2)}h`);

export const fmtMoney = (cents) =>
  cents == null ? '--' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

/** mm:ss countdown used by the status check-in prompt. */
export function fmtCountdown(seconds) {
  if (seconds == null || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** Value for an <input type="datetime-local">, in local time. */
export function toLocalInput(d) {
  const date = d ? new Date(d) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const toDateInput = (d) => toLocalInput(d).slice(0, 10);

export const initials = (name) =>
  (name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
