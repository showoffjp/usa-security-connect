import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtMoney, fmtDate, fmtDateShort, fmtDateTime } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, Stat, Modal, Field, Banner, Progress, useToast } from '../../components/ui.jsx';

export const money = (dollars) => (dollars == null ? '--' : fmtMoney(Math.round(dollars * 100)));
export const periodRange = (p) => `${fmtDateShort(p.period_start)} to ${fmtDate(p.period_end)}`;

/** Where a period stands, in the words an administrator would use. */
export function periodState(p) {
  if (p.status === 'closed') return { kind: 'ok', label: 'Closed' };
  const t = p.totals || {};
  if ((p.blockers || []).some((b) => b.code === 'not_ended')) return { kind: 'navy', label: 'In progress' };
  if (!p.blockers?.length) return { kind: 'brand', label: 'Ready to close' };
  const waiting = (t.pending || 0) + (t.changed || 0);
  return { kind: 'warn', label: waiting ? `${waiting} to approve` : 'Needs attention' };
}

/* --------------------------------------------------------- open one -- */

function OpenDialog({ suggestion, onClose, onCreated }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({
    periodStart: suggestion?.periodStart || '',
    periodEnd: suggestion?.periodEnd || '',
    notes: '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const res = await api.post('/admin/payroll/periods', form);
      toast.success('Pay period opened.');
      onCreated(res.period);
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Open a pay period"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.periodStart || !form.periodEnd}>
            {busy ? 'Opening...' : 'Open period'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Pay periods run in whole payroll weeks, Monday to Sunday, up to four weeks, so overtime is never split
          between two periods. You can open the current period to review hours as they come in; it can be closed
          the day after it ends.
        </p>
        <div className="grid grid-2">
          <Field label="First day (a Monday)" required error={errors.periodStart}>
            <input type="date" value={form.periodStart} onChange={set('periodStart')} />
          </Field>
          <Field label="Last day (a Sunday)" required error={errors.periodEnd}>
            <input type="date" value={form.periodEnd} onChange={set('periodEnd')} />
          </Field>
        </div>
        <Field label="Notes" hint="Optional - a pay date, a holiday, anything payroll should know." error={errors.notes}>
          <input value={form.notes} onChange={set('notes')} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- page -- */

export default function PayrollPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/payroll/periods'));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { periods: [], suggestion: null });
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <LoadingPage label="Loading payroll" />;

  const periods = data.periods;
  const due = periods.filter((p) => p.status === 'open' && !p.blockers.some((b) => b.code === 'not_ended'));
  const lastClosed = periods.find((p) => p.status === 'closed');
  const closedThisYear = periods.filter(
    (p) => p.status === 'closed' && String(p.period_start).slice(0, 4) === String(new Date().getFullYear())
  );
  const ytd = closedThisYear.reduce((n, p) => n + (p.totals.gross_pay || 0), 0);
  const ytdW2 = closedThisYear.reduce((n, p) => n + (p.totals.w2_pay || 0), 0);

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Workforce</div>
          <h1>Payroll</h1>
          <p className="lead">Review each pay period, approve every officer's hours, then close it and export the register.</p>
        </div>
        <div className="row wrap">
          <Link className="btn btn-ghost" to="/admin/timesheets">
            <Icon name="clock" size={16} /> Timesheets
          </Link>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => setOpening(true)}>
              <Icon name="plus" size={16} /> Open pay period
            </button>
          )}
        </div>
      </div>

      {!isAdmin && (
        <Banner kind="info" title="View only">
          Supervisors can review hours and pay. Only an administrator can approve, close or export payroll.
        </Banner>
      )}

      {due.length > 0 && (
        <Banner kind="warn" title={`${due.length} pay period${due.length === 1 ? ' has' : 's have'} ended and ${due.length === 1 ? 'is' : 'are'} waiting to close`}>
          {due.map((p) => (
            <div key={p.id} className="small">
              <Link to={`/admin/payroll/${p.id}`}>{periodRange(p)}</Link>
              {' - '}
              {p.blockers.length ? p.blockers.map((b) => b.message).join(' ') : 'everyone is approved; ready to close.'}
            </div>
          ))}
        </Banner>
      )}

      <div className="grid grid-4">
        <Stat label="Waiting to close" value={due.length} foot={due.length ? 'Ended, still open' : 'Nothing overdue'} alert={due.length > 0} />
        <Stat
          label="Last closed"
          value={lastClosed ? money(lastClosed.totals.gross_pay) : '--'}
          foot={lastClosed ? `${periodRange(lastClosed)} · ${lastClosed.totals.people} paid` : 'No period closed yet'}
        />
        <Stat label={`Paid in ${new Date().getFullYear()}`} value={money(ytd)} foot={`W-2 ${money(ytdW2)} · 1099 ${money(ytd - ytdW2)}`} />
        <Stat
          label="Overtime, last closed"
          value={lastClosed ? `${lastClosed.totals.overtime_hours}h` : '--'}
          foot={lastClosed ? `of ${lastClosed.totals.hours}h worked` : ''}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="h3">Pay periods</h2>
          <span className="small muted">{periods.length} on record</span>
        </div>
        {periods.length === 0 ? (
          <Empty
            icon="dollar"
            title="No pay periods yet"
            action={
              isAdmin && (
                <button className="btn btn-primary" onClick={() => setOpening(true)}>
                  Open the first one
                </button>
              )
            }
          >
            Open a period to review and approve the hours worked in it.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Pay periods</caption>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="num">Officers</th>
                  <th className="num">Hours</th>
                  <th className="num">Overtime</th>
                  <th className="num">W-2</th>
                  <th className="num">1099</th>
                  <th className="num">Gross</th>
                  <th>Approved</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => {
                  const state = periodState(p);
                  const t = p.totals;
                  return (
                    <tr key={p.id} className="clickable" onClick={() => navigate(`/admin/payroll/${p.id}`)}>
                      <td className="nowrap">
                        <Link className="strong small" to={`/admin/payroll/${p.id}`} onClick={(e) => e.stopPropagation()}>
                          {periodRange(p)}
                        </Link>
                        <div className="tiny muted">
                          {p.status === 'closed'
                            ? `Closed ${fmtDateTime(p.closed_at)}${p.closed_by_name ? ` by ${p.closed_by_name}` : ''}`
                            : p.reopened_at
                              ? `Reopened ${fmtDateShort(p.reopened_at)}`
                              : p.notes || ''}
                        </div>
                      </td>
                      <td>
                        <Chip kind={state.kind}>{state.label}</Chip>
                      </td>
                      <td className="num">{t.people}</td>
                      <td className="num">{t.hours}h</td>
                      <td className="num">{t.overtime_hours ? `${t.overtime_hours}h` : '--'}</td>
                      <td className="num small">{money(t.w2_pay)}</td>
                      <td className="num small">{money(t.contractor_pay)}</td>
                      <td className="num strong">{money(t.gross_pay)}</td>
                      <td style={{ minWidth: 140 }}>
                        <Progress value={t.approved} max={Math.max(1, t.people)} ok={t.approved === t.people} label="Officers approved" />
                        <div className="tiny muted">
                          {t.approved} of {t.people}
                          {t.changed ? ` · ${t.changed} changed` : ''}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {opening && (
        <OpenDialog
          suggestion={data.suggestion}
          onClose={() => setOpening(false)}
          onCreated={(p) => {
            setOpening(false);
            navigate(`/admin/payroll/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
