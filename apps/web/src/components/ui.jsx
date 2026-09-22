import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ mark -- */

/** Original shield mark for USA Security Connect. */
export function Shield({ size = 32, className }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} role="img" aria-label="USA Security Connect">
      <path d="M32 3 8 12v22c0 14 10 23 24 27 14-4 24-13 24-27V12L32 3Z" fill="#001F3F" />
      <path d="M32 9 14 16v18c0 11 7.6 17.8 18 21.3 10.4-3.5 18-10.3 18-21.3V16L32 9Z" fill="#AA2F19" />
      <path
        d="M32 20a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.6a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z"
        fill="#fff"
      />
    </svg>
  );
}

export function Wordmark() {
  return (
    <>
      <Shield size={30} />
      <span>
        <span className="name">USA Security Connect</span>
        <br />
        <span className="sub">Protection Group</span>
      </span>
    </>
  );
}

/* ----------------------------------------------------------------- icons -- */

const iconPaths = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  alert: 'M12 3 2 20h20L12 3Zm0 6v5m0 3v.5',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  route: 'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 11v3a4 4 0 0 1-4 4H6',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1ZM17 8a5 5 0 0 1 0 8',
  message: 'M4 5h16v11H9l-5 4V5Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21a7 7 0 0 1 14 0',
  users: 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M17 5a4 4 0 0 1 0 8M22 21a6 6 0 0 0-4-5.6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  flag: 'M5 21V4h13l-2.5 4L18 12H5',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  building: 'M4 21V6l7-3 7 3v15M4 21h16M9 10h2M13 10h2M9 14h2M13 14h2M9 18h6',
  shield: 'M12 3 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-3Z',
  check: 'M4 12.5 9 17.5 20 6.5',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1Z',
  camera: 'M3 8h3l2-3h8l2 3h3v12H3V8Zm9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  pin: 'M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  nfc: 'M5 5a12 12 0 0 1 0 14M9 8a7 7 0 0 1 0 8M13 11a2.5 2.5 0 0 1 0 2M17 4v16',
  play: 'M8 5v14l11-7-11-7Z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  clipboard: 'M9 4h6v3H9zM7 6H5v15h14V6h-2M9 12h6M9 16h4',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M4 20h16',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  book: 'M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5Zm2 13h13',
};

export function Icon({ name, size = 20, stroke = 1.8, filled = false, ...rest }) {
  const d = iconPaths[name];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

/* --------------------------------------------------------------- toasts -- */

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, kind = 'info', ms = 4000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const value = {
    toast: push,
    success: (m) => push(m, 'ok'),
    error: (m) => push(m, 'err', 6000),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext) || { toast: () => {}, success: () => {}, error: () => {} };

/* ---------------------------------------------------------- primitives -- */

export function Spinner({ dark = false }) {
  return <span className={`spinner${dark ? ' dark' : ''}`} aria-hidden="true" />;
}

export function LoadingPage({ label = 'Loading' }) {
  return (
    <div className="loading-page">
      <div className="stack-sm" style={{ alignItems: 'center' }}>
        <Spinner dark />
        <span className="small muted">{label}...</span>
      </div>
    </div>
  );
}

export function Empty({ icon = 'clipboard', title, children, action }) {
  return (
    <div className="empty">
      <Icon name={icon} size={40} stroke={1.4} />
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
      {action}
    </div>
  );
}

export function Banner({ kind = 'info', title, children, action }) {
  const icons = { warn: 'alert', danger: 'alert', ok: 'check', info: 'alert' };
  return (
    <div className={`banner banner-${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      <Icon name={icons[kind]} size={18} />
      <div className="grow">
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function Field({ label, error, hint, children, required }) {
  return (
    <div className="field">
      {label && (
        <label>
          {label}
          {required && <span style={{ color: 'var(--brand-600)' }}> *</span>}
        </label>
      )}
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export function Chip({ kind = '', children, dot = false }) {
  return (
    <span className={`chip ${kind ? `chip-${kind}` : ''}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/** Maps a flag / status value to the right chip colour. */
export function StatusChip({ value }) {
  const map = {
    inside: ['ok', 'In geofence'],
    outside: ['danger', 'Outside geofence'],
    unverified: ['warn', 'GPS unverified'],
    no_fix: ['warn', 'No GPS fix'],
    not_configured: ['', 'No geofence'],
    ok: ['ok', 'On time'],
    late: ['warn', 'Late'],
    missed: ['danger', 'Missed'],
    pending: ['', 'Pending'],
    cancelled: ['', 'Cancelled'],
    scheduled: ['info', 'Scheduled'],
    in_progress: ['brand', 'In progress'],
    completed: ['ok', 'Completed'],
    completed_with_skips: ['warn', 'Completed, skips'],
    abandoned: ['danger', 'Abandoned'],
    submitted: ['info', 'Submitted'],
    under_review: ['warn', 'Under review'],
    closed: ['ok', 'Closed'],
    active: ['ok', 'Active'],
    suspended: ['warn', 'Suspended'],
    terminated: ['', 'Former'],
    on_leave: ['info', 'On leave'],
    applicant: ['brand', 'Applicant'],
    approved: ['ok', 'Approved'],
    denied: ['danger', 'Denied'],
    acknowledged: ['warn', 'Responding'],
    resolved: ['ok', 'Resolved'],
    false_alarm: ['', 'False alarm'],
    expired: ['danger', 'Expired'],
    expiring: ['warn', 'Expiring'],
    valid: ['ok', 'Valid'],
    low: ['', 'Low'],
    medium: ['info', 'Medium'],
    high: ['warn', 'High'],
    critical: ['danger', 'Critical'],
    urgent: ['danger', 'Urgent'],
    important: ['warn', 'Important'],
    normal: ['', 'Normal'],
    done: ['ok', 'Done'],
    skipped: ['warn', 'Skipped'],
    warning: ['warn', 'Warning'],
    info: ['info', 'Info'],
  };
  const [kind, label] = map[value] || ['', value || '--'];
  return <Chip kind={kind}>{label}</Chip>;
}

export function Modal({ title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { maxWidth: 820 } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, max = 100, ok = false }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className={ok ? 'ok' : ''} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stat({ label, value, foot, alert = false }) {
  return (
    <div className={`stat${alert ? ' alert' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

/* --------------------------------------------------- slide to clock in -- */

/**
 * Deliberate drag-to-confirm control.
 *
 * Clocking in or out is a payroll record, so it should never happen from a
 * stray tap in a pocket. Works with mouse, touch and - for accessibility -
 * the keyboard, where Enter or Space confirms directly.
 */
export function SlideToAction({ label, onConfirm, variant = 'in', disabled = false, busy = false }) {
  const trackRef = useRef(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);
  const KNOB = 50;

  const maxX = () => Math.max(0, (trackRef.current?.offsetWidth || 260) - KNOB - 8);

  const finish = useCallback(async () => {
    setDone(true);
    try {
      await onConfirm();
    } finally {
      setDone(false);
      setX(0);
    }
  }, [onConfirm]);

  useEffect(() => {
    if (!dragging) return;

    const move = (clientX) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      setX(Math.max(0, Math.min(maxX(), clientX - rect.left - KNOB / 2)));
    };
    const onMove = (e) => move(e.touches ? e.touches[0].clientX : e.clientX);
    const onUp = () => {
      setDragging(false);
      // Committed once the knob passes ~85% of the track.
      setX((current) => {
        if (current >= maxX() * 0.85) {
          finish();
          return maxX();
        }
        return 0;
      });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [dragging, finish]);

  const locked = disabled || busy || done;

  return (
    <div
      ref={trackRef}
      className={`slider ${variant === 'out' ? 'out' : ''} ${done ? 'done' : ''} ${disabled ? 'disabled' : ''}`}
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-label={label}
      aria-disabled={locked}
      onKeyDown={(e) => {
        if (locked) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          finish();
        }
      }}
    >
      <div className="fill" style={{ width: x + KNOB }} />
      <div className="track-label">{busy || done ? 'Working...' : label}</div>
      <div
        className="knob"
        style={{ transform: `translateX(${x}px)`, transition: dragging ? 'none' : 'transform 0.18s ease' }}
        onMouseDown={() => !locked && setDragging(true)}
        onTouchStart={() => !locked && setDragging(true)}
      >
        {busy || done ? <Spinner dark /> : <Icon name="chevron" size={22} stroke={2.4} />}
      </div>
    </div>
  );
}
