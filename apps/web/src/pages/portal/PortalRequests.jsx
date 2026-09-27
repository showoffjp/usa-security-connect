import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../lib/api.js';
import { fmtDateTime, fmtTime, toDateInput } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, useToast } from '../../components/ui.jsx';

const STATUS = {
  open: ['warn', 'Waiting for a reply'],
  scheduled: ['ok', 'Scheduled'],
  declined: ['danger', 'Declined'],
  cancelled: ['', 'Withdrawn'],
};

/** Combine a date and a HH:MM time into a local Date. */
const at = (day, time) => {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
};

function RequestForm({ sites, onSent }) {
  const toast = useToast();
  const tomorrow = new Date(Date.now() + 86400000);
  const [form, setForm] = useState({
    siteId: sites[0]?.id ?? '',
    day: toDateInput(tomorrow),
    from: '18:00',
    to: '23:00',
    officers: 1,
    armed: false,
    reason: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const start = form.day && form.from ? at(form.day, form.from) : null;
  let end = form.day && form.to ? at(form.day, form.to) : null;
  // A finish earlier than the start runs past midnight.
  const overnight = start && end && end <= start;
  if (overnight) end = new Date(end.getTime() + 86400000);
  const hours = start && end ? Math.round(((end - start) / 3600000) * 10) / 10 : 0;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await clientApi.post('/client/coverage-requests', {
        siteId: Number(form.siteId),
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        officers: Number(form.officers),
        armed: Boolean(form.armed),
        reason: form.reason,
      });
      toast.success('Request sent. We will reply here and by email.');
      setForm((f) => ({ ...f, reason: '' }));
      onSent();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card card-pad stack" onSubmit={submit}>
      <h2 className="h3" style={{ margin: 0 }}>Ask for extra coverage</h2>
      <p className="small muted" style={{ margin: 0 }}>
        An event, a delivery, a stretch of extra risk. Tell us when and how many officers; the office confirms it here
        and by email. For anything starting within the hour, call the office.
      </p>
      {sites.length > 1 && (
        <Field label="Property" required error={errors.siteId}>
          <select value={form.siteId} onChange={set('siteId')}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-3">
        <Field label="Date" required>
          <input type="date" value={form.day} min={toDateInput(new Date())} onChange={set('day')} />
        </Field>
        <Field label="From" required>
          <input type="time" value={form.from} onChange={set('from')} />
        </Field>
        <Field label="To" required hint={overnight ? 'Finishes the next morning.' : undefined}>
          <input type="time" value={form.to} onChange={set('to')} />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Officers" required error={errors.officers}>
          <input type="number" min="1" max="10" value={form.officers} onChange={set('officers')} />
        </Field>
        <label className="row small" style={{ alignSelf: 'end', paddingBottom: 10 }}>
          <input type="checkbox" checked={form.armed} onChange={set('armed')} style={{ width: 'auto' }} />
          Armed officers needed
        </label>
      </div>
      <Field label="What is it for?" required error={errors.reason} hint="Where they should stand and anything they should know.">
        <textarea rows={3} value={form.reason} onChange={set('reason')} maxLength={1000} />
      </Field>
      <div className="row-between wrap">
        <span className="small muted">
          {hours > 0 ? `${form.officers} officer${Number(form.officers) === 1 ? '' : 's'} for ${hours} hours` : ''}
        </span>
        <button className="btn btn-primary" type="submit" disabled={busy || form.reason.trim().length < 5 || !hours}>
          <Icon name="plus" size={16} /> {busy ? 'Sending...' : 'Send request'}
        </button>
      </div>
    </form>
  );
}

export default function PortalRequests({ sites }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await clientApi.get('/client/coverage-requests'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const withdraw = async (id) => {
    try {
      await clientApi.post(`/client/coverage-requests/${id}/cancel`);
      toast.success('Request withdrawn.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1>Extra coverage</h1>
        <p className="muted">Request officers beyond your standing schedule, and see what we have confirmed.</p>
      </div>

      <RequestForm sites={sites} onSent={load} />

      {error && <Banner kind="danger" title="Your requests did not load">{error}</Banner>}
      {!data && !error ? (
        <LoadingPage label="Loading your requests" />
      ) : data ? (
        <div className="card">
          <div className="card-head">
            <h2 className="h3">Your requests</h2>
            <span className="small muted">{data.requests.length}</span>
          </div>
          {data.requests.length === 0 ? (
            <Empty icon="calendar" title="No requests yet">
              Requests you send appear here with our reply.
            </Empty>
          ) : (
            <ul className="list">
              {data.requests.map((r) => {
                const [kind, label] = STATUS[r.status] || ['', r.status];
                return (
                  <li key={r.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                    <div className="grow">
                      <div className="row wrap" style={{ gap: 6 }}>
                        <span className="strong small">
                          {fmtDateTime(r.starts_at)} to {fmtTime(r.ends_at)}
                        </span>
                        <Chip kind={kind}>{label}</Chip>
                        {r.armed && <Chip kind="warn">Armed</Chip>}
                      </div>
                      <div className="tiny muted" style={{ marginTop: 3 }}>
                        {r.site_name} · {r.officers} officer{r.officers === 1 ? '' : 's'} · asked {fmtDateTime(r.created_at)}
                      </div>
                      <div className="small" style={{ marginTop: 4 }}>{r.reason}</div>
                      {r.response && (
                        <div className="small" style={{ marginTop: 6 }}>
                          <strong>Our reply:</strong> {r.response}
                        </div>
                      )}
                    </div>
                    {r.status === 'open' && (
                      <button className="btn btn-sm btn-ghost" onClick={() => withdraw(r.id)}>
                        Withdraw
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
