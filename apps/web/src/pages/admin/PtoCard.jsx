import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';
import { Field, Modal, useToast } from '../../components/ui.jsx';
import { fmtPeriod } from '../officer/MyTimeOff.jsx';

const h = (n) => `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;

function AdjustDialog({ userId, pto, name, onClose, onDone }) {
  const toast = useToast();
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const n = Number(hours);
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.post(`/time-off/pto/${userId}/adjust`, { hours: n, note: note.trim() });
      toast.success(`Balance ${n > 0 ? 'increased' : 'reduced'} by ${h(Math.abs(n))}.`);
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Adjust ${name}'s paid time off`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !n || note.trim().length < 5}>
            {busy ? 'Saving...' : 'Adjust the balance'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          The balance is {h(pto.balance)}; it can be from nothing up to {h(pto.rules.capHours)}.
        </div>
        <Field label="Hours" required error={errors.hours} hint="Negative to take hours off, for a payout or a mistake.">
          <input type="number" inputMode="decimal" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <Field label="Why" required error={errors.note} hint="On the officer's statement and the audit log.">
          <textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Someone's paid time off, on their employee record. */
export default function PtoCard({ userId, name, isAdmin }) {
  const toast = useToast();
  const [pto, setPto] = useState(null);
  const [adjusting, setAdjusting] = useState(false);
  const load = useCallback(async () => {
    try {
      setPto(await api.get(`/time-off/pto/${userId}`));
    } catch (err) {
      toast.error(err.message);
    }
  }, [userId, toast]);
  useEffect(() => {
    load();
  }, [load]);

  if (!pto || !pto.eligible) return null;
  return (
    <div className="card" id="pto">
      <div className="card-head wrap">
        <h3>Paid time off</h3>
        <span className="small muted">
          {h(pto.balance)} · {h(pto.pending)} asked for · {h(pto.available)} free
        </span>
        {isAdmin && (
          <button className="btn btn-ghost btn-sm" onClick={() => setAdjusting(true)}>
            Adjust
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="data">
          <caption className="sr-only">Paid time off statement</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>What</th>
              <th>By</th>
              <th className="num">Hours</th>
            </tr>
          </thead>
          <tbody>
            {pto.history.slice(0, 10).map((e) => (
              <tr key={e.id}>
                <td className="nowrap small">{fmtDate(e.created_at)}</td>
                <td className="small">
                  {e.kind_label}
                  <div className="tiny muted">
                    {e.kind === 'accrual' && e.period ? `Hours worked ${fmtPeriod(e.period)}` : null}
                    {e.kind === 'used' && e.time_off ? `Time off from ${fmtDate(e.time_off.starts_on)}` : null}
                    {e.kind === 'adjustment' ? e.note : null}
                  </div>
                </td>
                <td className="small">{e.created_by || '--'}</td>
                <td className="num strong nowrap" style={{ color: e.hours < 0 ? 'var(--danger)' : 'var(--ok)' }}>
                  {e.hours > 0 ? '+' : ''}
                  {e.hours}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adjusting && (
        <AdjustDialog
          userId={userId}
          pto={pto}
          name={name}
          onClose={() => setAdjusting(false)}
          onDone={() => {
            setAdjusting(false);
            load();
          }}
        />
      )}
    </div>
  );
}
