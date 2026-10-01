import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateShort, fmtTime, toLocalInput } from '../../lib/format.js';
import { Chip, Field, Icon, Modal, useToast } from '../../components/ui.jsx';
import { formatDuration } from '@shared/domain.js';

const STATUS_KIND = { pending: 'warn', approved: 'ok', declined: 'danger', withdrawn: '' };

/** Ask for one shift's times to be fixed. Only what changed is sent. */
function FixTimes({ entry, onClose, onSent }) {
  const toast = useToast();
  const [clockIn, setClockIn] = useState(toLocalInput(entry.clock_in_at));
  const [clockOut, setClockOut] = useState(entry.clock_out_at ? toLocalInput(entry.clock_out_at) : '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const inChanged = clockIn && clockIn !== toLocalInput(entry.clock_in_at);
  const outChanged = entry.clock_out_at && clockOut && clockOut !== toLocalInput(entry.clock_out_at);

  const send = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.post('/time-corrections', {
        entryId: entry.id,
        clockInAt: inChanged ? new Date(clockIn).toISOString() : null,
        clockOutAt: outChanged ? new Date(clockOut).toISOString() : null,
        reason,
      });
      toast.success('Sent to the office. You will see their answer here.');
      onSent();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Fix a time"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={send} disabled={busy || (!inChanged && !outChanged) || reason.trim().length < 10}>
            {busy ? 'Sending...' : 'Send to the office'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          {entry.post_name}, {entry.site_name}. Recorded {fmtDateShort(entry.clock_in_at)}, {fmtTime(entry.clock_in_at)}
          {entry.clock_out_at ? ` to ${fmtTime(entry.clock_out_at)}` : ' (still clocked in)'}.
        </div>
        <div className="grid grid-2">
          <Field label="Clock-in should be" error={errors.clockInAt}>
            <input type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
          </Field>
          <Field label="Clock-out should be" error={errors.clockOutAt} hint={entry.clock_out_at ? null : 'Clock out first to fix this.'}>
            <input type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} disabled={!entry.clock_out_at} />
          </Field>
        </div>
        <Field label="What happened?" hint="For example: my relief was late and I stayed until they arrived. The office checks it against the post log." error={errors.reason}>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * The officer's own punches from the last two weeks, with a way to ask for a
 * wrong one to be fixed and what the office said about it.
 */
export default function RecentPunches() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [fixing, setFixing] = useState(null);

  const load = useCallback(() => {
    api.get('/time-corrections/mine').then(setData, () => setData({ entries: [], windowDays: 14 }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const withdraw = async (c) => {
    try {
      await api.post(`/time-corrections/${c.id}/withdraw`);
      toast.success('Request withdrawn.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!data || !data.entries.length) return null;
  return (
    <section className="card" aria-labelledby="punches-title">
      <div className="card-head">
        <div className="row">
          <Icon name="clock" size={18} style={{ color: 'var(--brand-text)' }} />
          <h3 id="punches-title">Your punches</h3>
        </div>
        <span className="small muted">Last {data.windowDays} days</span>
      </div>
      <ul className="list">
        {data.entries.map((e) => {
          const c = e.correction;
          return (
            <li key={e.id} className="list-item punch-row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
              <div className="grow">
                <div className="small strong">
                  {fmtDateShort(e.clock_in_at)} · {fmtTime(e.clock_in_at)} to {e.clock_out_at ? fmtTime(e.clock_out_at) : 'now'}
                </div>
                <div className="tiny muted">
                  {e.post_name} · {e.site_name}
                  {e.minutes_worked != null ? ` · ${formatDuration(e.minutes_worked)}` : ''}
                </div>
                <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                  {e.auto_closed && <Chip kind="danger">Closed by the system</Chip>}
                  {e.late_minutes > 0 && <Chip kind="warn">{e.late_minutes}m late</Chip>}
                  {e.adjusted && <Chip kind="info">Corrected</Chip>}
                  {c && <Chip kind={STATUS_KIND[c.status]}>{c.status === 'pending' ? 'Correction waiting' : `Correction ${c.status}`}</Chip>}
                </div>
                {c?.decision_note && (
                  <div className="tiny" style={{ marginTop: 4 }}>
                    <strong>Office:</strong> {c.decision_note}
                  </div>
                )}
              </div>
              {c?.status === 'pending' ? (
                <button className="btn btn-sm btn-ghost" onClick={() => withdraw(c)} aria-label={`Withdraw the correction for ${fmtDateShort(e.clock_in_at)}`}>
                  Withdraw
                </button>
              ) : (
                <button className="btn btn-sm" onClick={() => setFixing(e)} aria-label={`Fix a time on ${fmtDateShort(e.clock_in_at)}`}>
                  Fix a time
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {fixing && (
        <FixTimes
          entry={fixing}
          onClose={() => setFixing(null)}
          onSent={() => {
            setFixing(null);
            load();
          }}
        />
      )}
    </section>
  );
}
