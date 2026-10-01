import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate } from '../../lib/format.js';
import { Chip, Field, LoadingPage, Modal, Stat, useToast } from '../../components/ui.jsx';

const h = (n) => (n == null ? '--' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`);

/** Rostered against contracted, with the open shifts nobody has taken shown after the filled part. */
function HoursBar({ filled, open, contracted }) {
  const max = Math.max(contracted || 0, filled + open, 1);
  return (
    <div className="ag-bar" aria-hidden="true">
      <span className="ag-filled" style={{ width: `${(filled / max) * 100}%` }} />
      <span className="ag-open" style={{ width: `${(open / max) * 100}%` }} />
      {contracted ? <span className="ag-target" style={{ left: `${(contracted / max) * 100}%` }} /> : null}
    </div>
  );
}

function EditAgreement({ site, onClose, onSaved }) {
  const toast = useToast();
  const a = site.agreement;
  const [form, setForm] = useState({
    weeklyHours: a ? String(a.weekly_hours) : String(Math.round(site.rostered_hours || 40)),
    startsOn: a?.starts_on || '',
    endsOn: a?.ends_on || '',
    noticeDays: String(a?.notice_days ?? 60),
    autoRenew: a?.auto_renew ?? false,
    notes: a?.notes || '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.put(`/admin/agreements/${site.id}`, {
        weeklyHours: Number(form.weeklyHours),
        startsOn: form.startsOn || null,
        endsOn: form.endsOn || null,
        noticeDays: Number(form.noticeDays || 0),
        autoRenew: form.autoRenew,
        notes: form.notes || null,
      });
      toast.success('Agreement saved.');
      onSaved();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/admin/agreements/${site.id}`);
      toast.success('Agreement removed.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={a ? `Agreement: ${site.name}` : `Set an agreement: ${site.name}`}
      onClose={onClose}
      footer={
        <>
          {a && (
            <button className="btn btn-ghost" onClick={remove} disabled={busy} style={{ marginRight: 'auto' }}>
              Remove
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !(Number(form.weeklyHours) > 0)}>
            {busy ? 'Saving...' : 'Save agreement'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Hours a week the client pays for" required error={errors.weeklyHours} hint={`Rostered for the next 7 days: ${h(site.rostered_hours)}${site.open_hours ? `, plus ${h(site.open_hours)} not yet filled` : ''}.`}>
          <input type="number" min="1" step="0.5" value={form.weeklyHours} onChange={set('weeklyHours')} />
        </Field>
        <div className="grid grid-2">
          <Field label="Starts" error={errors.startsOn}>
            <input type="date" value={form.startsOn} onChange={set('startsOn')} />
          </Field>
          <Field label="Ends" error={errors.endsOn}>
            <input type="date" value={form.endsOn} onChange={set('endsOn')} />
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label="Notice period (days)" error={errors.noticeDays} hint="Renewal is flagged this long before the end.">
            <input type="number" min="0" max="365" value={form.noticeDays} onChange={set('noticeDays')} />
          </Field>
          <label className="check" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={form.autoRenew} onChange={set('autoRenew')} />
            Renews on its own
          </label>
        </div>
        <Field label="Notes (internal)" hint="Rates, contacts, anything about the contract. Clients never see these.">
          <textarea rows={3} value={form.notes} onChange={set('notes')} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * What each property pays for, against what is rostered for the next week
 * and what was worked in the last. Short weeks and renewals coming up are
 * marked; an administrator keeps the agreements up to date.
 */
export default function AgreementsPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/agreements'));
    } catch (err) {
      toast.error(err.message);
      setData({ sites: [], summary: {} });
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <LoadingPage label="Loading service agreements" />;
  const s = data.summary;

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="eyebrow">Billing</div>
          <h1>Service agreements</h1>
          <p className="lead">The hours each property pays for, against the roster for the next 7 days and the hours worked in the last 7.</p>
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Contracted" value={h(s.contractedHours)} foot={`A week, ${s.withAgreement} of ${s.sites} sites`} />
        <Stat label="Rostered" value={h(s.rosteredHours)} foot="Next 7 days, those sites" />
        <Stat label="Short" value={s.short ?? 0} foot="Rostered below the agreement" alert={s.short > 0} />
        <Stat label="Renewals" value={s.renewals ?? 0} foot="Inside the notice period" alert={s.renewals > 0} />
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Site</th>
                <th className="num">Hours a week</th>
                <th>Next 7 days</th>
                <th className="num">Last 7 days</th>
                <th>Agreement ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.sites.map((site) => {
                const a = site.agreement;
                return (
                  <tr key={site.id}>
                    <td>
                      <span className="strong">{site.name}</span>
                      <div className="tiny muted">{[site.client_name, site.city].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="num strong">{a ? h(a.weekly_hours) : <span className="muted small">None</span>}</td>
                    <td style={{ minWidth: 200 }}>
                      <HoursBar filled={site.rostered_hours} open={site.open_hours} contracted={a?.weekly_hours} />
                      <div className="tiny" style={{ marginTop: 4 }}>
                        {h(site.rostered_hours)} rostered
                        {site.open_hours ? <span className="muted">, {h(site.open_hours)} open</span> : null}
                        {site.short && (
                          <>
                            {' '}
                            <Chip kind="danger">{h(site.shortfall_hours)} short</Chip>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="num small">
                      {h(site.delivered_hours)}
                      {site.delivered_pct != null && <div className="tiny muted">{site.delivered_pct}% of a week</div>}
                    </td>
                    <td className="small">
                      {a?.ends_on ? fmtDate(`${a.ends_on}T12:00:00`) : <span className="muted">{a ? 'No end date' : 'Month to month'}</span>}
                      <div>
                        {a?.expired ? (
                          <Chip kind="danger">Ended</Chip>
                        ) : a?.renewal_due ? (
                          <Chip kind="warn">Renewal due, {a.days_left} days</Chip>
                        ) : a?.auto_renew ? (
                          <Chip kind="ok">Renews on its own</Chip>
                        ) : null}
                      </div>
                    </td>
                    <td className="num">
                      {isAdmin && (
                        <button className="btn btn-sm" onClick={() => setEditing(site)} aria-label={`${a ? 'Edit' : 'Set'} the agreement for ${site.name}`}>
                          {a ? 'Edit' : 'Set agreement'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>
        The bar shows shifts with an officer on them in the next 7 days, then open shifts nobody has taken, against the line at the contracted hours.
        Short means the filled shifts fall more than half an hour below the agreement.
      </p>

      {editing && (
        <EditAgreement
          site={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}
