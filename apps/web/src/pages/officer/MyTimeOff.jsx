import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDateShort, toDateInput } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, Modal, Stat, StatusChip, useToast } from '../../components/ui.jsx';
import { TIME_OFF_LABEL, TIME_OFF_TYPES, PTO_DAY_MAX_HOURS } from '@shared/domain.js';

const h = (n) => `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
const daysBetween = (a, b) => (a && b ? Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000) + 1 : 0);
export const fmtPeriod = (s) => (s ? s.split(' to ').map(fmtDateShort).join(' to ') : '');

/** Time off: the paid time off balance, the requests, and asking for more. */
export default function MyTimeOff() {
  const toast = useToast();
  const [pto, setPto] = useState(null);
  const [requests, setRequests] = useState(null);
  const [asking, setAsking] = useState(false);
  const [statement, setStatement] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.get('/time-off/pto'), api.get('/time-off')]);
      setPto(p);
      setRequests(r.requests);
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const withdraw = async (r) => {
    if (!window.confirm(`Withdraw your ${TIME_OFF_LABEL[r.type]?.toLowerCase() || r.type} request for ${fmtDate(r.starts_on)}?`)) return;
    try {
      await api.del(`/time-off/${r.id}`);
      toast.success('Request withdrawn.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!pto || !requests) return null;

  return (
    <div className="card" id="time-off">
      <div className="card-head wrap">
        <h3>Time off</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setAsking(true)}>
          <Icon name="calendar" size={16} /> Request time off
        </button>
      </div>
      <div className="card-body stack">
        {pto.eligible ? (
          <>
            <div className="grid grid-3">
              <Stat label="Paid time off" value={h(pto.balance)} foot={`An hour for every ${pto.rules.accrualWorkedHours} worked, up to ${pto.rules.capHours}`} />
              <Stat label="Asked for" value={h(pto.pending)} foot="In requests still waiting" />
              <Stat label="Free to use" value={h(pto.available)} />
            </div>
            <button className="link-btn small" onClick={() => setStatement((v) => !v)} aria-expanded={statement}>
              {statement ? 'Hide the statement' : 'See the statement'}
            </button>
            {statement && (
              <div className="table-wrap">
                <table className="data">
                  <caption className="sr-only">Paid time off statement</caption>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>What</th>
                      <th className="num">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pto.history.map((e) => (
                      <tr key={e.id}>
                        <td className="nowrap small">{fmtDate(e.created_at)}</td>
                        <td className="small">
                          {e.kind_label}
                          <div className="tiny muted">
                            {e.kind === 'accrual' && e.period ? `Hours worked ${fmtPeriod(e.period)}` : null}
                            {e.kind === 'used' && e.time_off ? `Time off ${fmtDate(e.time_off.starts_on)}${e.time_off.ends_on !== e.time_off.starts_on ? ` to ${fmtDate(e.time_off.ends_on)}` : ''}` : null}
                            {e.kind === 'adjustment' ? e.note : null}
                          </div>
                        </td>
                        <td className="num strong nowrap" style={{ color: e.hours < 0 ? 'var(--danger)' : 'var(--ok)' }}>
                          {e.hours > 0 ? '+' : ''}
                          {e.hours}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="small muted">Paid time off is earned by W-2 employees paid by the hour. You can still ask for time off, unpaid.</div>
        )}

        {requests.length === 0 ? (
          <Empty icon="calendar" title="No requests yet">
            Ask for time off here and your supervisor decides.
          </Empty>
        ) : (
          <div className="list">
            {requests.slice(0, 8).map((r) => {
              const days = daysBetween(r.starts_on, r.ends_on);
              return (
                <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
                  <div className="lead-icon">
                    <Icon name="calendar" size={17} />
                  </div>
                  <div className="grow">
                    <div className="small strong">
                      {TIME_OFF_LABEL[r.type] || r.type} · {fmtDate(r.starts_on)}
                      {days > 1 ? ` to ${fmtDate(r.ends_on)}` : ''}
                    </div>
                    <div className="tiny muted">
                      {days} day{days === 1 ? '' : 's'}
                      {r.pto_hours ? ` · ${h(r.pto_hours)} from your balance` : ' · unpaid'}
                      {r.pto_paid_in ? ` · paid with the payroll for ${fmtPeriod(r.pto_paid_in)}` : ''}
                    </div>
                    {r.decision_note && <div className="tiny muted">{r.decided_by_name ? `${r.decided_by_name}: ` : ''}{r.decision_note}</div>}
                    {r.status === 'pending' && (
                      <button className="link-btn tiny" onClick={() => withdraw(r)}>
                        Withdraw
                      </button>
                    )}
                  </div>
                  <div className="list-trailing">
                    <StatusChip value={r.status} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {asking && (
        <RequestTimeOff
          pto={pto}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function RequestTimeOff({ pto, onClose, onDone }) {
  const toast = useToast();
  const tomorrow = toDateInput(new Date(Date.now() + 86400000));
  const [type, setType] = useState('vacation');
  const [startsOn, setStartsOn] = useState(tomorrow);
  const [endsOn, setEndsOn] = useState(tomorrow);
  const [reason, setReason] = useState('');
  const [paid, setPaid] = useState(pto.eligible && pto.available > 0);
  const [hours, setHours] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const days = Math.max(0, daysBetween(startsOn, endsOn));
  const canPay = pto.eligible && type !== 'unpaid' && pto.available > 0;
  const usePto = canPay && paid;
  // A full day is eight hours unless they say otherwise, and never more than they have.
  const suggested = Math.min(days * 8, pto.available);
  const asked = hours === '' ? suggested : Number(hours);
  const over = usePto && asked > pto.available;

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.post('/time-off', {
        type,
        startsOn,
        endsOn,
        reason: reason.trim() || undefined,
        ptoHours: usePto && asked > 0 ? asked : undefined,
      });
      toast.success('Request sent to your supervisor.');
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Request time off"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || days < 1 || over}>
            {busy ? 'Sending...' : 'Send request'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Type" required error={errors.type}>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TIME_OFF_TYPES.map((t) => (
              <option key={t} value={t}>
                {TIME_OFF_LABEL[t] || t}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-2">
          <Field label="First day off" required error={errors.startsOn}>
            <input type="date" value={startsOn} onChange={(e) => {
              setStartsOn(e.target.value);
              if (e.target.value > endsOn) setEndsOn(e.target.value);
            }} />
          </Field>
          <Field label="Last day off" required error={errors.endsOn}>
            <input type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>
        {canPay ? (
          <div className="stack" style={{ gap: 8 }}>
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
              Pay it from my paid time off ({h(pto.available)} free)
            </label>
            {paid && (
              <Field label="Hours from my balance" error={errors.ptoHours || (over ? `You have ${h(pto.available)}.` : null)}
                hint={`Eight hours a day is suggested; at most ${PTO_DAY_MAX_HOURS} a day.`}>
                <input type="number" inputMode="decimal" min="0.25" step="0.25" max={Math.min(pto.available, days * PTO_DAY_MAX_HOURS)}
                  value={hours} placeholder={String(suggested)} onChange={(e) => setHours(e.target.value)} />
              </Field>
            )}
          </div>
        ) : pto.eligible && type === 'unpaid' ? (
          <div className="small muted">Unpaid leave is not paid from your balance.</div>
        ) : pto.eligible ? (
          <Banner kind="info">
            <span className="small">You have no paid time off free to use, so this would be unpaid.</span>
          </Banner>
        ) : null}
        <Field label="Reason" hint="Optional, but it helps the decision." error={errors.reason}>
          <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="small muted">
          {days} day{days === 1 ? '' : 's'}
          {usePto && asked > 0 ? <> · <Chip kind="ok">{h(asked)} paid</Chip></> : ' · unpaid'}
        </div>
      </div>
    </Modal>
  );
}
