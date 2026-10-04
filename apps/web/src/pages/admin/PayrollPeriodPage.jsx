import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadFile } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, Stat, Modal, Field, Banner, Segmented, useToast } from '../../components/ui.jsx';
import { PAY_TYPE_LABEL, TIME_OFF_LABEL } from '@shared/domain.js';
import { money, periodRange, periodState } from './PayrollPage.jsx';

const APPROVAL = {
  approved: ['ok', 'Approved'],
  changed: ['danger', 'Changed since approval'],
  pending: ['warn', 'Not approved'],
  closed: ['ok', 'Paid'],
};

function ReopenDialog({ period, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/payroll/periods/${period.id}/reopen`, { reason });
      toast.success('Period reopened. Punches and rates in it can be corrected again.');
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Reopen this pay period?"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={save} disabled={busy || reason.trim().length < 5}>
            {busy ? 'Reopening...' : 'Reopen period'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>
          Reopening unlocks the punches and pay rates in {periodRange(period)}. Approvals stay in place, but any
          officer whose hours or rate then change must be approved again before the period can close. The reason is
          kept on the audit log.
        </p>
        <Field label="Why is it being reopened?" required>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Missed overtime for a relief shift" />
        </Field>
      </div>
    </Modal>
  );
}

export default function PayrollPeriodPage() {
  const { id } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [reopening, setReopening] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/admin/payroll/periods/${id}`));
      setFailed(false);
    } catch (err) {
      toast.error(err.message);
      setFailed(true);
    }
  }, [id, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const lines = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.lines.filter(
      (l) =>
        (tab === 'all' ||
          (tab === 'attention' && (l.approval.state === 'pending' || l.approval.state === 'changed' || l.blocked)) ||
          (tab === 'approved' && l.approval.state === 'approved') ||
          (tab === 'w2' && l.employment_type === 'w2') ||
          (tab === '1099' && l.employment_type === '1099')) &&
        (!q || l.officer.toLowerCase().includes(q) || String(l.employee_code).includes(q) || l.sites.some((s) => s.site.toLowerCase().includes(q)))
    );
  }, [data, tab, query]);

  if (failed && !data) {
    return (
      <div className="page">
        <Empty icon="dollar" title="Pay period not found" action={<Link className="btn btn-primary" to="/admin/payroll">Back to payroll</Link>} />
      </div>
    );
  }
  if (!data) return <LoadingPage label="Loading pay period" />;

  const { period, totals, blockers } = data;
  const open = period.status === 'open';
  const canEdit = isAdmin && open;
  const state = periodState({ ...period, totals, blockers });
  const attention = data.lines.filter((l) => l.approval.state === 'pending' || l.approval.state === 'changed' || l.blocked).length;
  const selectable = lines.filter((l) => !l.blocked && l.approval.state !== 'approved');

  const act = async (fn, success) => {
    setBusy(true);
    try {
      const res = await fn();
      if (success) toast.success(typeof success === 'function' ? success(res) : success);
      setSelected(new Set());
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const approve = (userIds) =>
    act(
      () => api.post(`/admin/payroll/periods/${period.id}/approve`, userIds ? { userIds } : {}),
      (res) =>
        `${res.approved.length} approved` +
        (res.skipped.length ? `, ${res.skipped.length} skipped: ${res.skipped.map((s) => `${s.officer || s.userId} (${s.reason})`).join('; ')}` : '.')
    );
  const unapprove = (userId) => act(() => api.del(`/admin/payroll/periods/${period.id}/approvals/${userId}`), 'Approval removed.');
  const close = () =>
    act(() => api.post(`/admin/payroll/periods/${period.id}/close`), (res) => `Period closed: ${money(res.totals.gross_pay)} across ${res.totals.people} officers.`);
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/admin/payroll/periods/${period.id}`);
      toast.success('Pay period deleted.');
      navigate('/admin/payroll');
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  const exportCsv = async () => {
    try {
      await downloadFile(`/admin/payroll/periods/${period.id}/register.csv`, `payroll-${period.period_start}-to-${period.period_end}.csv`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const toggle = (userId) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  const allSelected = selectable.length > 0 && selectable.every((l) => selected.has(l.user_id));

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">
            <Link to="/admin/payroll">Payroll</Link>
          </div>
          <h1 className="row wrap" style={{ gap: 10 }}>
            {periodRange(period)} <Chip kind={state.kind}>{state.label}</Chip>
          </h1>
          <p className="lead">
            {period.status === 'closed'
              ? `Closed ${fmtDateTime(period.closed_at)}${period.closed_by_name ? ` by ${period.closed_by_name}` : ''}. These figures are what was paid and no longer change.`
              : 'Every officer with hours in this period. Approve each one, then close the period to lock it.'}
          </p>
        </div>
        <div className="row wrap">
          {isAdmin && (
            <button className="btn btn-ghost" onClick={exportCsv}>
              <Icon name="download" size={16} /> Payroll register
            </button>
          )}
          {canEdit && totals.approved === 0 && (
            <button className="btn btn-ghost" onClick={remove} disabled={busy}>
              Delete period
            </button>
          )}
          {canEdit && attention > 0 && (
            <button className="btn btn-navy" onClick={() => approve(null)} disabled={busy}>
              <Icon name="check" size={16} /> Approve all ready
            </button>
          )}
          {canEdit && (
            <button className="btn btn-primary" onClick={close} disabled={busy || blockers.length > 0}>
              <Icon name="shield" size={16} /> Close period
            </button>
          )}
          {isAdmin && !open && (
            <button className="btn btn-ghost" onClick={() => setReopening(true)}>
              Reopen
            </button>
          )}
        </div>
      </div>

      {period.reopen_reason && open && (
        <Banner kind="info" title="Reopened">
          {period.reopen_reason}
        </Banner>
      )}
      {open && blockers.length > 0 && (
        <Banner kind={blockers.some((b) => b.code === 'not_ended') && blockers.length === 1 ? 'info' : 'warn'} title="Before this period can close">
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {blockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
        </Banner>
      )}
      {open && blockers.length === 0 && (
        <Banner kind="ok" title="Ready to close">
          Every officer is approved at their current figures. Closing locks the punches and pay rates in this period.
        </Banner>
      )}

      <div className="grid grid-4">
        <Stat label="Officers" value={totals.people} foot={`${totals.approved} approved${totals.changed ? ` · ${totals.changed} changed` : ''}${totals.blocked ? ` · ${totals.blocked} blocked` : ''}`} alert={totals.changed > 0 || totals.blocked > 0} />
        <Stat label="Hours" value={`${totals.hours}h`} foot={totals.overtime_hours ? `${totals.overtime_hours}h overtime` : 'No overtime'} />
        <Stat label="Gross pay" value={money(totals.gross_pay)} foot={[totals.overtime_pay ? `incl. ${money(totals.overtime_pay)} overtime` : '', totals.holiday_pay ? `${money(totals.holiday_pay)} holiday premium` : '', totals.pto_pay ? `+ ${money(totals.pto_pay)} paid time off` : '', totals.reimbursements ? `+ ${money(totals.reimbursements)} expenses` : ''].filter(Boolean).join(' · ')} />
        <Stat label="W-2 · 1099" value={money(totals.w2.pay)} foot={`W-2 ${totals.w2.people} · 1099 ${money(totals.contractor.pay)} across ${totals.contractor.people}`} />
      </div>

      <div className="card">
        <div className="card-head wrap">
          <Segmented
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'all', label: `All (${data.lines.length})` },
              ...(open ? [{ value: 'attention', label: `Needs attention (${attention})` }, { value: 'approved', label: 'Approved' }] : []),
              { value: 'w2', label: 'W-2' },
              { value: '1099', label: '1099' },
            ]}
          />
          <div className="row wrap">
            {canEdit && selected.size > 0 && (
              <button className="btn btn-navy btn-sm" onClick={() => approve([...selected])} disabled={busy}>
                Approve selected ({selected.size})
              </button>
            )}
            <input
              type="search"
              aria-label="Search officers"
              placeholder="Search name, code or site"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 220 }}
            />
          </div>
        </div>
        {lines.length === 0 ? (
          <Empty icon="users" title={data.lines.length ? 'Nobody matches' : 'No hours in this period'}>
            {data.lines.length ? null : 'Nobody has clocked in during these dates.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Hours and pay by officer</caption>
              <thead>
                <tr>
                  {canEdit && (
                    <th style={{ width: 32 }}>
                      <input
                        type="checkbox"
                        aria-label="Select every officer ready to approve"
                        checked={allSelected}
                        disabled={selectable.length === 0}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((l) => l.user_id)))}
                        style={{ width: 'auto' }}
                      />
                    </th>
                  )}
                  <th>Officer</th>
                  <th className="num">Hours</th>
                  <th className="num">Regular</th>
                  <th className="num">Overtime</th>
                  <th className="num">Holiday</th>
                  <th className="num">Gross</th>
                  <th>Where</th>
                  <th>Check</th>
                  <th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const [kind, label] = APPROVAL[l.approval.state];
                  const canSelect = !l.blocked && l.approval.state !== 'approved';
                  return (
                    <tr key={l.user_id}>
                      {canEdit && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${l.officer}`}
                            checked={selected.has(l.user_id)}
                            disabled={!canSelect}
                            onChange={() => toggle(l.user_id)}
                            style={{ width: 'auto' }}
                          />
                        </td>
                      )}
                      <td style={{ minWidth: 180 }}>
                        <Link className="small strong nowrap" to={`/admin/employees/${l.user_id}`}>
                          {l.officer}
                        </Link>
                        <div className="tiny muted row wrap" style={{ gap: 4 }}>
                          {l.employee_code} · {PAY_TYPE_LABEL[l.pay_type] || l.pay_type}
                          <Chip kind={l.employment_type === '1099' ? 'brand' : 'navy'}>{l.employment_type === '1099' ? '1099' : 'W-2'}</Chip>
                        </div>
                      </td>
                      <td className="num nowrap">
                        {l.hours}h
                        <div className="tiny muted">{l.entries} shift{l.entries === 1 ? '' : 's'}</div>
                      </td>
                      <td className="num small nowrap">
                        {money(l.regular_pay)}
                        <div className="tiny muted">{l.regular_hours}h</div>
                      </td>
                      <td className="num small nowrap">
                        {l.overtime_minutes > 0 ? (
                          <>
                            <span style={{ color: 'var(--warn)' }}>{money(l.overtime_pay)}</span>
                            <div className="tiny muted">{l.overtime_hours}h</div>
                          </>
                        ) : (
                          <span className="muted">--</span>
                        )}
                      </td>
                      <td className="num small nowrap">
                        {l.holiday_minutes > 0 ? (
                          <>
                            <span>{l.holiday_pay ? money(l.holiday_pay) : 'In overtime'}</span>
                            <div className="tiny muted">{l.holiday_hours}h</div>
                          </>
                        ) : (
                          <span className="muted">--</span>
                        )}
                      </td>
                      <td className="num strong nowrap">
                        {money(l.gross_pay)}
                        {l.approval.state === 'changed' && l.approval.approved_gross != null && (
                          <div className="tiny muted">was {money(l.approval.approved_gross)}</div>
                        )}
                      </td>
                      <td className="small" style={{ minWidth: 120 }}>
                        {l.sites.slice(0, 1).map((s) => (
                          <div key={s.site} className="truncate" style={{ maxWidth: 150 }} title={l.sites.map((x) => `${x.site}: ${x.hours}h`).join('\n')}>
                            {s.site}
                          </div>
                        ))}
                        {l.sites.length > 1 && <div className="tiny muted">+{l.sites.length - 1} more</div>}
                      </td>
                      <td style={{ minWidth: 170, maxWidth: 230 }}>
                        {l.issues.length === 0 ? (
                          <span className="tiny muted">{open ? 'Nothing to check' : '--'}</span>
                        ) : (
                          <ul className="issue-list">
                            {l.issues.map((i) => (
                              <li key={i.code} className={`issue-${i.level}`}>
                                {i.message}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td style={{ minWidth: 150 }}>
                        <Chip kind={kind}>{label}</Chip>
                        {l.approval.approved_by_name && (
                          <div className="tiny muted nowrap">
                            {l.approval.approved_by_name}, {fmtDateTime(l.approval.approved_at)}
                          </div>
                        )}
                        {canEdit && (
                          <div style={{ marginTop: 4 }}>
                            {l.approval.state === 'approved' ? (
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => unapprove(l.user_id)}
                                disabled={busy}
                                aria-label={`Undo approval for ${l.officer}`}
                              >
                                Undo
                              </button>
                            ) : (
                              <button
                                className="btn btn-navy btn-sm"
                                onClick={() => approve([l.user_id])}
                                disabled={busy || l.blocked}
                                aria-label={`${l.approval.state === 'changed' ? 'Re-approve' : 'Approve'} ${l.officer}`}
                                title={l.blocked ? l.issues.filter((i) => i.level === 'block').map((i) => i.message).join(' ') : undefined}
                              >
                                {l.approval.state === 'changed' ? 'Re-approve' : 'Approve'}
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.expenses && (data.expenses.claims.length > 0 || open) && (
        <div className="card" id="reimbursements">
          <div className="card-head wrap">
            <h3>{open ? 'Expenses this close pays' : 'Expenses paid with this period'}</h3>
            <span className="small muted">
              {money(data.expenses.total)} reimbursed, apart from gross pay ·{' '}
              <Link to="/admin/expenses">All claims</Link>
            </span>
          </div>
          {data.expenses.claims.length === 0 ? (
            <Empty icon="dollar" title="No approved claims to pay">
              {data.expenses.pending ? `${data.expenses.pending} claim${data.expenses.pending === 1 ? ' is' : 's are'} waiting for a decision.` : 'Approved expense claims are paid here.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <caption className="sr-only">Expense claims reimbursed with this period</caption>
                <thead>
                  <tr>
                    <th>Officer</th>
                    <th>Date</th>
                    <th>What for</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.expenses.claims.map((c) => (
                    <tr key={c.id}>
                      <td className="small strong nowrap">{c.officer}</td>
                      <td className="small nowrap">{fmtDate(c.incurred_on)}</td>
                      <td className="small">
                        {c.category_label}
                        {c.miles != null ? ` · ${c.miles} mi` : ''}
                        <div className="tiny muted">{c.description}</div>
                      </td>
                      <td className="num strong nowrap">{money(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {data.pto && (data.pto.items.length > 0 || open) && (
        <div className="card" id="paid-time-off">
          <div className="card-head wrap">
            <h3>{open ? 'Paid time off this close pays' : 'Paid time off paid with this period'}</h3>
            <span className="small muted">
              {data.pto.hours} h · {money(data.pto.total)}, apart from gross pay ·{' '}
              {open ? `the hours worked earn ${data.pto.accrued} h more` : `the hours worked earned ${data.pto.accrued} h`} ·{' '}
              <Link to="/admin/time-off">Time off</Link>
            </span>
          </div>
          {data.pto.items.length === 0 ? (
            <Empty icon="calendar" title="No paid time off to pay">
              {data.pto.pending
                ? `${data.pto.pending} request${data.pto.pending === 1 ? ' is' : 's are'} waiting for a decision.`
                : 'Approved time off paid from a balance is paid here.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <caption className="sr-only">Paid time off paid with this period</caption>
                <thead>
                  <tr>
                    <th>Officer</th>
                    <th>Time off</th>
                    <th className="num">Hours</th>
                    <th className="num">Rate</th>
                    <th className="num">Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pto.items.map((i) => (
                    <tr key={i.request_id}>
                      <td className="small strong nowrap">{i.officer}</td>
                      <td className="small nowrap">
                        {TIME_OFF_LABEL[i.type] || i.type} · {fmtDate(i.starts_on)}
                        {i.ends_on !== i.starts_on ? ` to ${fmtDate(i.ends_on)}` : ''}
                      </td>
                      <td className="num small">{i.hours}</td>
                      <td className="num small">{money(i.rate)}</td>
                      <td className="num strong nowrap">{money(i.pay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {reopening && (
        <ReopenDialog
          period={period}
          onClose={() => setReopening(false)}
          onDone={() => {
            setReopening(false);
            load();
          }}
        />
      )}
    </div>
  );
}
