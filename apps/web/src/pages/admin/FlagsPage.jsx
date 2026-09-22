import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Field, Segmented, useToast,
} from '../../components/ui.jsx';
import { FLAG_LABEL, FLAG_TYPES } from '@shared/domain.js';

/** Human sentence for the JSON we stored alongside each flag. */
function describe(flag) {
  const d = flag.detail || {};
  switch (flag.type) {
    case FLAG_TYPES.LATE_CLOCK_IN:
      return `Clocked in ${d.late_minutes} minutes past the grace period.`;
    case FLAG_TYPES.MISSED_CHECK_IN:
      return d.answered
        ? `Answered the check-in ${d.late_by_minutes} minutes late.`
        : 'Did not answer the status check-in within the window.';
    case FLAG_TYPES.GEOFENCE_VIOLATION:
      return [
        d.distance_m != null ? `Clocked in ${d.distance_m}m from the post (limit ${d.radius_m}m).` : 'Location could not be verified.',
        d.reason ? `Officer's reason: "${d.reason}"` : null,
      ]
        .filter(Boolean)
        .join(' ');
    case FLAG_TYPES.MISSED_CLOCK_OUT:
      return d.note || 'Did not clock out; the entry was closed automatically.';
    case FLAG_TYPES.EARLY_DEPARTURE:
      return `Left ${d.early_by_minutes} minutes before the scheduled end of shift.`;
    case FLAG_TYPES.NO_SHOW:
      return 'Never clocked in for a scheduled shift.';
    case FLAG_TYPES.UNSCHEDULED_SHIFT:
      return `Clocked in at ${d.post} without a matching scheduled shift.`;
    default:
      return '';
  }
}

function ResolveDialog({ flag, onClose, onSaved }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/flags/${flag.id}/resolve`, { note: note.trim() });
      toast.success('Flag closed.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Resolve: ${flag.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || note.trim().length < 3}>
            Close flag
          </button>
        </>
      }
    >
      <div className="stack">
        <dl className="kv">
          <dt>Officer</dt>
          <dd>
            {flag.officer} ({flag.employee_code})
          </dd>
          <dt>Occurred</dt>
          <dd>{fmtDateTime(flag.occurred_at)}</dd>
          <dt>Severity</dt>
          <dd>
            <StatusChip value={flag.severity} />
          </dd>
        </dl>
        <p className="small">{describe(flag)}</p>
        <Field label="Outcome" hint="What did you do about it? Kept on the officer's record." required>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Spoke with the officer - traffic incident on the bridge. Verbal coaching given."
          />
        </Field>
      </div>
    </Modal>
  );
}

export default function FlagsPage() {
  const toast = useToast();
  const [flags, setFlags] = useState(null);
  const [resolved, setResolved] = useState('open');
  const [typeFilter, setTypeFilter] = useState('');
  const [active, setActive] = useState(null);

  const load = async () => {
    try {
      const res = await api.get(`/admin/flags?resolved=${resolved === 'closed'}`);
      setFlags(res.flags);
    } catch (err) {
      toast.error(err.message);
      setFlags([]);
    }
  };
  useEffect(() => {
    load();
  }, [resolved]);

  const filtered = useMemo(
    () => (flags || []).filter((f) => !typeFilter || f.type === typeFilter),
    [flags, typeFilter]
  );

  const byType = useMemo(() => {
    const counts = {};
    (flags || []).forEach((f) => {
      counts[f.type] = (counts[f.type] || 0) + 1;
    });
    return counts;
  }, [flags]);

  if (!flags) return <LoadingPage label="Loading flags" />;

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">Compliance</div>
        <h1>Flags</h1>
        <p className="lead">
          Raised automatically from clock, check-in and geofence data. Closing one records what you did about it.
        </p>
      </div>

      <div className="row-between wrap">
        <Segmented
          label="Flag status"
          value={resolved}
          onChange={setResolved}
          options={[
            { value: 'open', label: `Open (${resolved === 'open' ? flags.length : ''})`.replace(' ()', '') },
            { value: 'closed', label: 'Closed' },
          ]}
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All types</option>
          {Object.entries(FLAG_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label} {byType[value] ? `(${byType[value]})` : ''}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <Empty icon="check" title={resolved === 'open' ? 'Nothing outstanding' : 'No closed flags'}>
            {resolved === 'open' ? 'Every compliance alert has been dealt with.' : null}
          </Empty>
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {filtered.map((f) => (
              <div key={f.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <div
                  className="lead-icon"
                  style={
                    f.resolved_at
                      ? { background: 'var(--ok-bg)', color: 'var(--ok)' }
                      : f.severity === 'critical'
                        ? { background: 'var(--danger-bg)', color: 'var(--danger)' }
                        : { background: 'var(--warn-bg)', color: 'var(--warn)' }
                  }
                >
                  <Icon name={f.resolved_at ? 'check' : 'flag'} size={18} />
                </div>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 7 }}>
                    <span className="strong small">{f.label}</span>
                    <StatusChip value={f.severity} />
                    <Link to={`/admin/employees/${f.user_id}`} className="small">
                      {f.officer}
                    </Link>
                    <span className="tiny muted mono">{f.employee_code}</span>
                  </div>
                  <div className="small" style={{ color: 'var(--ink-3)', marginTop: 2 }}>
                    {describe(f)}
                  </div>
                  <div className="tiny muted" style={{ marginTop: 2 }}>
                    {fmtDateTime(f.occurred_at)} &middot; {fmtRelative(f.occurred_at)}
                  </div>
                  {f.resolved_at && (
                    <div className="tiny" style={{ color: 'var(--ok)', marginTop: 4 }}>
                      Closed by {f.resolved_by_name} - {f.resolution_note}
                    </div>
                  )}
                </div>
                {!f.resolved_at && (
                  <button className="btn btn-sm btn-primary" onClick={() => setActive(f)}>
                    Resolve
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {active && (
        <ResolveDialog
          flag={active}
          onClose={() => setActive(null)}
          onSaved={() => {
            setActive(null);
            load();
          }}
        />
      )}
    </div>
  );
}
