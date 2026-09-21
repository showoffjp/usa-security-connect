const bad = (d) => !d || Number.isNaN(new Date(d).getTime());

export const fmtTime = (d) =>
  bad(d) ? '--' : new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDate = (d) =>
  bad(d) ? '--' : new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtDateShort = (d) =>
  bad(d) ? '--' : new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });

export const fmtDateTime = (d) => (bad(d) ? '--' : `${fmtDateShort(d)}, ${fmtTime(d)}`);

export const fmtRange = (a, b) => `${fmtTime(a)} - ${fmtTime(b)}`;

export function fmtDay(d) {
  if (bad(d)) return '--';
  const date = new Date(d);
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
  const diff = new Date(d).getTime() - Date.now();
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
