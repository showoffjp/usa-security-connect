import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtMoney, fmtDateShort, toDateInput } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, Stat, Modal, Field, Banner, Segmented, useToast } from '../../components/ui.jsx';
import { PAY_TYPE_LABEL, EMPLOYMENT_LABEL } from '@shared/domain.js';

const money = (dollars) => (dollars == null ? '--' : fmtMoney(Math.round(dollars * 100)));
const rate = (dollars) => (dollars == null ? '--' : `${money(dollars)}/h`);

/* ---------------------------------------------------------- edit -- */

function EditDialog({ person, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({
    employmentType: person.employment_type,
    payType: person.pay_type,
    exempt: person.exempt,
    payRate: person.pay_rate ?? '',
    salary: person.salary ?? '',
    billRate: person.bill_rate ?? '',
    overtimeMultiplier: person.overtime_multiplier ?? 1.5,
    effectiveOn: toDateInput(new Date()),
    reason: '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const w2 = form.employmentType === 'w2';
  const payRate = Number(form.payRate) || 0;
  const billRate = Number(form.billRate) || 0;
  const earnsOt = w2 && !form.exempt && form.payType === 'hourly';
  const margin = billRate > 0 && form.payType === 'hourly' ? Math.round(((billRate - payRate) / billRate) * 1000) / 10 : null;

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.patch(`/admin/pay-rates/${person.id}`, {
        employmentType: form.employmentType,
        payType: form.payType,
        exempt: w2 ? Boolean(form.exempt) : false,
        payRate: form.payRate === '' ? null : Number(form.payRate),
        salary: form.salary === '' ? null : Number(form.salary),
        billRate: form.billRate === '' ? null : Number(form.billRate),
        overtimeMultiplier: Number(form.overtimeMultiplier) || 1.5,
        effectiveOn: form.effectiveOn,
        reason: form.reason,
      });
      toast.success(`Rates updated for ${person.name}.`);
      onSaved();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Pay & billing - ${person.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.reason.trim().length < 3}>
            {busy ? 'Saving...' : 'Save rates'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Classification" required>
          <Segmented
            label="Classification"
            value={form.employmentType}
            onChange={(v) => setForm((f) => ({ ...f, employmentType: v, exempt: v === '1099' ? false : f.exempt }))}
            options={[
              { value: 'w2', label: 'W-2 employee' },
              { value: '1099', label: '1099 contractor' },
            ]}
          />
        </Field>
        {!w2 && !person.w9_on_file && (
          <Banner kind="warn" title="No W-9 on file">
            An active contractor needs a W-9 before they can be paid on 1099 terms. Record it on the employee
            record first.
          </Banner>
        )}
        {w2 ? (
          <p className="tiny muted" style={{ margin: 0 }}>
            W-2 hourly staff earn overtime past 40 hours in a payroll week unless marked exempt.
          </p>
        ) : (
          <p className="tiny muted" style={{ margin: 0 }}>
            Contractors are paid their agreed rate for every hour, never overtime, and invoice for it.
          </p>
        )}

        <div className="grid grid-2">
          <Field label="Pay basis" error={errors.payType}>
            <select value={form.payType} onChange={set('payType')}>
              {Object.entries(PAY_TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {form.payType === 'salary' ? (
            <Field label="Salary ($ per period)" error={errors.salary} required>
              <input type="number" min="0" step="0.01" value={form.salary} onChange={set('salary')} />
            </Field>
          ) : (
            <Field label={form.payType === 'per_shift' ? 'Pay per shift ($)' : 'Pay rate ($/hour)'} error={errors.payRate} required>
              <input type="number" min="0" step="0.01" value={form.payRate} onChange={set('payRate')} />
            </Field>
          )}
        </div>

        <div className="grid grid-2">
          <Field label="Bill rate ($/hour)" hint="Used when the post has no standing rate." error={errors.billRate}>
            <input type="number" min="0" step="0.01" value={form.billRate} onChange={set('billRate')} />
          </Field>
          {w2 && (
            <Field label="Overtime multiplier" error={errors.overtimeMultiplier}>
              <input type="number" min="1" max="3" step="0.25" value={form.overtimeMultiplier} onChange={set('overtimeMultiplier')} />
            </Field>
          )}
        </div>

        {w2 && (
          <label className="row small">
            <input type="checkbox" checked={Boolean(form.exempt)} onChange={set('exempt')} style={{ width: 'auto' }} />
            Exempt from overtime (salaried manager)
          </label>
        )}

        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          <dl className="kv">
            <dt>Overtime rate</dt>
            <dd>{earnsOt && payRate ? rate(payRate * (Number(form.overtimeMultiplier) || 1.5)) : 'Not applicable'}</dd>
            <dt>Margin on own bill rate</dt>
            <dd style={{ color: margin != null && margin < 20 ? 'var(--danger)' : undefined }}>
              {margin != null ? `${margin}%` : '--'}
            </dd>
          </dl>
        </div>

        <div className="grid grid-2">
          <Field label="Effective from" required>
            <input type="date" value={form.effectiveOn} onChange={set('effectiveOn')} />
          </Field>
          <Field label="Reason for the change" required error={errors.reason}>
            <input value={form.reason} onChange={set('reason')} placeholder="e.g. Annual review" maxLength={300} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- bulk -- */

function BulkDialog({ onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState({
    employmentType: 'w2',
    armed: 'all',
    field: 'pay',
    mode: 'percent',
    value: '3',
    effectiveOn: toDateInput(new Date()),
    reason: '',
  });
  const set = (k) => (e) => {
    setPreview(null);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const run = async (dryRun) => {
    setBusy(true);
    try {
      const res = await api.post('/admin/pay-rates/bulk', {
        ...form,
        value: Number(form.value),
        dryRun,
      });
      if (dryRun) setPreview(res);
      else {
        toast.success(`${res.count} rate(s) updated.`);
        onSaved();
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Adjust rates for a group"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-ghost" onClick={() => run(true)} disabled={busy || form.reason.trim().length < 3}>
            Preview
          </button>
          <button
            className="btn btn-primary"
            onClick={() => run(false)}
            disabled={busy || !preview || preview.count === 0 || form.reason.trim().length < 3}
          >
            Apply to {preview?.count ?? 0}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-3">
          <Field label="Who">
            <select value={form.employmentType} onChange={set('employmentType')}>
              <option value="w2">W-2 employees</option>
              <option value="1099">1099 contractors</option>
              <option value="all">Everyone</option>
            </select>
          </Field>
          <Field label="Licence">
            <select value={form.armed} onChange={set('armed')}>
              <option value="all">Armed and unarmed</option>
              <option value="armed">Armed (Class G) only</option>
              <option value="unarmed">Unarmed only</option>
            </select>
          </Field>
          <Field label="Which rate">
            <select value={form.field} onChange={set('field')}>
              <option value="pay">Pay rate</option>
              <option value="bill">Bill rate</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-3">
          <Field label="Change by">
            <select value={form.mode} onChange={set('mode')}>
              <option value="percent">Percent</option>
              <option value="amount">Dollars per hour</option>
            </select>
          </Field>
          <Field label={form.mode === 'percent' ? 'Percent (+/-)' : 'Dollars (+/-)'}>
            <input type="number" step="0.25" value={form.value} onChange={set('value')} />
          </Field>
          <Field label="Effective from">
            <input type="date" value={form.effectiveOn} onChange={set('effectiveOn')} />
          </Field>
        </div>
        <Field label="Reason" required>
          <input value={form.reason} onChange={set('reason')} placeholder="e.g. 2027 cost-of-living adjustment" />
        </Field>

        {preview && (
          <div className="card">
            <div className="card-head">
              <h3>Preview</h3>
              <span className="small muted">{preview.count} people</span>
            </div>
            {preview.count === 0 ? (
              <Empty icon="users" title="Nobody matches" />
            ) : (
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="num">Now</th>
                      <th className="num">New</th>
                      <th className="num">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.changes.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="num">{rate(c.from)}</td>
                        <td className="num strong">{rate(c.to)}</td>
                        <td className="num">{money(Math.round((c.to - c.from) * 100) / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------- history -- */

function HistoryDialog({ person, onClose }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api
      .get(`/admin/pay-rates/${person.id}/history`)
      .then((d) => setRows(d.history))
      .catch((err) => {
        toast.error(err.message);
        setRows([]);
      });
  }, [person.id, toast]);

  return (
    <Modal title={`Rate history - ${person.name}`} onClose={onClose} wide>
      {!rows ? (
        <LoadingPage label="Loading history" />
      ) : rows.length === 0 ? (
        <Empty icon="dollar" title="No changes recorded" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Class</th>
                <th>Basis</th>
                <th className="num">Pay</th>
                <th className="num">Bill</th>
                <th>Reason</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id}>
                  <td className="nowrap">{fmtDateShort(h.effective_on)}</td>
                  <td>{h.employment_type === '1099' ? '1099' : 'W-2'}</td>
                  <td>{PAY_TYPE_LABEL[h.pay_type]}</td>
                  <td className="num">{h.pay_type === 'salary' ? money(h.salary) : rate(h.pay_rate)}</td>
                  <td className="num">{rate(h.bill_rate)}</td>
                  <td className="small">{h.reason || '--'}</td>
                  <td className="small muted">{h.changed_by_name || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------- page -- */

export default function PayRatesPage() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [history, setHistory] = useState(null);
  const [bulk, setBulk] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/pay-rates'));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { people: [], summary: {} });
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const people = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.people.filter(
      (p) =>
        (tab === 'all' ||
          (tab === 'w2' && p.employment_type === 'w2') ||
          (tab === '1099' && p.employment_type === '1099') ||
          (tab === 'armed' && p.armed)) &&
        (!q || p.name.toLowerCase().includes(q) || p.employee_code.includes(q) || (p.home_site || '').toLowerCase().includes(q))
    );
  }, [data, tab, query]);

  if (!data) return <LoadingPage label="Loading pay rates" />;
  const { w2, contractor, armed } = data.summary;

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Workforce</div>
          <h1>Pay rates</h1>
          <p className="lead">What every officer is paid and billed at, by W-2 or 1099 classification.</p>
        </div>
        <div className="row wrap">
          <Link className="btn btn-ghost" to="/admin/reports?report=payroll">
            <Icon name="chart" size={16} /> Payroll register
          </Link>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => setBulk(true)}>
              <Icon name="dollar" size={16} /> Adjust a group
            </button>
          )}
        </div>
      </div>

      {!isAdmin && (
        <Banner kind="info" title="View only">
          Supervisors can see rates to staff shifts against margin. Only an administrator can change them.
        </Banner>
      )}

      <div className="grid grid-4">
        <Stat label="W-2 average" value={w2?.avg_pay_rate != null ? rate(w2.avg_pay_rate) : '--'} foot={`${w2?.people ?? 0} people · ${rate(w2?.min_pay_rate)} to ${rate(w2?.max_pay_rate)}`} />
        <Stat label="1099 average" value={contractor?.avg_pay_rate != null ? rate(contractor.avg_pay_rate) : '--'} foot={`${contractor?.people ?? 0} contractors, no overtime`} />
        <Stat label="Armed average" value={armed?.avg_pay_rate != null ? rate(armed.avg_pay_rate) : '--'} foot={`${armed?.people ?? 0} Class G holders`} />
        <Stat label="Labor, last 28 days" value={money((w2?.pay_28d || 0) + (contractor?.pay_28d || 0))} foot={`W-2 ${money(w2?.pay_28d)} · 1099 ${money(contractor?.pay_28d)}`} />
      </div>

      <div className="card">
        <div className="card-head wrap">
          <Segmented
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'all', label: `All (${data.people.length})` },
              { value: 'w2', label: `W-2 (${w2?.people ?? 0})` },
              { value: '1099', label: `1099 (${contractor?.people ?? 0})` },
              { value: 'armed', label: `Armed (${armed?.people ?? 0})` },
            ]}
          />
          <input
            type="search"
            aria-label="Search people"
            placeholder="Search name, code or site"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 220 }}
          />
        </div>
        {people.length === 0 ? (
          <Empty icon="users" title="Nobody matches" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Pay and bill rates</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Classification</th>
                  <th>Basis</th>
                  <th className="num">Pay</th>
                  <th className="num">OT rate</th>
                  <th className="num">Bill</th>
                  <th className="num">Margin</th>
                  <th className="num">Hours · pay (28 days)</th>
                  <th>Last change</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td style={{ minWidth: 190 }}>
                      <Link className="small strong nowrap" to={`/admin/employees/${p.id}`}>
                        {p.name}
                      </Link>
                      <div className="tiny muted truncate" style={{ maxWidth: 220 }} title={p.home_site || ''}>
                        {p.employee_code}
                        {p.home_site ? ` · ${p.home_site}` : ''}
                        {p.status !== 'active' ? ` · ${p.status.replace('_', ' ')}` : ''}
                      </div>
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <div className="row wrap" style={{ gap: 4 }}>
                        <Chip kind={p.employment_type === '1099' ? 'brand' : 'navy'}>
                          {p.employment_type === '1099' ? '1099' : 'W-2'}
                        </Chip>
                        {p.exempt && <Chip>Exempt</Chip>}
                        {p.armed && <Chip kind="warn">Armed</Chip>}
                      </div>
                      {p.employment_type === '1099' && (
                        <div className="tiny muted">
                          {p.business_name || 'No business name'}
                          {!p.w9_on_file && <span style={{ color: 'var(--danger)' }}> · no W-9</span>}
                        </div>
                      )}
                    </td>
                    <td className="small">{PAY_TYPE_LABEL[p.pay_type]}</td>
                    <td className="num strong">
                      {p.pay_type === 'salary' ? money(p.salary) : p.pay_type === 'per_shift' ? `${money(p.pay_rate)}/shift` : rate(p.pay_rate)}
                    </td>
                    <td className="num small">{rate(p.overtime_rate)}</td>
                    <td className="num small nowrap">
                      {p.bill_rate != null ? (
                        rate(p.bill_rate)
                      ) : p.site_bill_rate != null ? (
                        <span title="Billed at the post's standing rate">
                          {rate(p.site_bill_rate)} <span className="tiny muted">site</span>
                        </span>
                      ) : (
                        <span className="muted">post rate</span>
                      )}
                    </td>
                    <td className="num small" style={{ color: p.margin_percent != null && p.margin_percent < 20 ? 'var(--danger)' : undefined }}>
                      {p.margin_percent != null ? `${p.margin_percent}%` : '--'}
                    </td>
                    <td className="num small nowrap">
                      {p.hours_28d}h · {money(p.pay_28d)}
                    </td>
                    <td className="small">
                      {p.last_change ? (
                        <>
                          {fmtDateShort(p.last_change.effective_on)}
                          <div className="tiny muted truncate" style={{ maxWidth: 170 }} title={p.last_change.reason || ''}>
                            {p.last_change.reason}
                          </div>
                        </>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setHistory(p)}>
                          History
                        </button>
                        {isAdmin && (
                          <button className="btn btn-navy btn-sm" onClick={() => setEditing(p)}>
                            Edit
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="tiny muted">
        {EMPLOYMENT_LABEL.w2}s are owed FLSA overtime at their multiplier past 40 hours a week; {EMPLOYMENT_LABEL['1099'].toLowerCase()}s are not.
        Pay for the last 28 days is an estimate - the payroll register works it out week by week.
      </p>

      {editing && (
        <EditDialog
          person={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {bulk && (
        <BulkDialog
          onClose={() => setBulk(false)}
          onSaved={() => {
            setBulk(false);
            load();
          }}
        />
      )}
      {history && <HistoryDialog person={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
