import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../lib/api.js';
import { fmtDateTime, fmtTime } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Segmented, useToast } from '../../components/ui.jsx';
import { CALL_TYPES, CALL_TYPE_LABEL, CALL_TARGET_MINUTES } from '@shared/domain.js';

const STATUS_KIND = { open: 'warn', assigned: 'warn', en_route: 'info', on_scene: 'ok', cleared: 'ok', cancelled: '' };

/** Ask for an officer now. An emergency is a 911 call, and the form says so first. */
function CallForm({ sites, onSent }) {
  const toast = useToast();
  const [form, setForm] = useState({
    siteId: sites[0]?.id ?? '', callType: 'suspicious', priority: 2, location: '', description: '', callerPhone: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await clientApi.post('/client/calls', {
        siteId: Number(form.siteId),
        callType: form.callType,
        priority: form.priority,
        location: form.location || null,
        description: form.description,
        callerPhone: form.callerPhone || null,
      });
      toast.success('Sent. The office is sending an officer; follow it here.');
      setForm((f) => ({ ...f, location: '', description: '' }));
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
      <h2 className="h3" style={{ margin: 0 }}>Request an officer</h2>
      <Banner kind="danger" title="An emergency? Call 911 first.">
        Fire, a medical emergency or a crime in progress: call 911, then the office on{' '}
        <a href="tel:+19045550100">(904) 555-0100</a>.
      </Banner>
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
      <div>
        <div className="small strong" style={{ marginBottom: 6 }}>
          How soon
        </div>
        <Segmented
          label="How soon"
          value={form.priority}
          onChange={(v) => setForm((f) => ({ ...f, priority: v }))}
          options={[
            { value: 2, label: 'Urgent' },
            { value: 3, label: 'Routine' },
          ]}
        />
        <div className="tiny muted" style={{ marginTop: 4 }}>
          {form.priority === 2
            ? `We aim to have an officer there within ${CALL_TARGET_MINUTES[2]} minutes.`
            : `We aim to have an officer there within ${CALL_TARGET_MINUTES[3]} minutes.`}
        </div>
      </div>
      <div className="grid grid-2">
        <Field label="What is it about?" error={errors.callType}>
          <select value={form.callType} onChange={set('callType')}>
            {CALL_TYPES.filter((t) => t !== 'medical').map((t) => (
              <option key={t} value={t}>
                {CALL_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Where on the property" error={errors.location}>
          <input value={form.location} onChange={set('location')} maxLength={160} placeholder="e.g. Parking garage level 2" />
        </Field>
      </div>
      <Field label="What is happening?" required error={errors.description}>
        <textarea rows={3} value={form.description} onChange={set('description')} maxLength={1000} />
      </Field>
      <Field label="A number to reach you on" error={errors.callerPhone} hint="Optional. The officer may call you when they arrive.">
        <input type="tel" value={form.callerPhone} onChange={set('callerPhone')} maxLength={30} autoComplete="tel" />
      </Field>
      <div className="row-between wrap">
        <span className="small muted">You can follow the officer from sent to on scene below.</span>
        <button className="btn btn-primary" type="submit" disabled={busy || form.description.trim().length < 5}>
          <Icon name="phone" size={16} /> {busy ? 'Sending...' : 'Send an officer'}
        </button>
      </div>
    </form>
  );
}

/** Where the call has got to, one line per step that has happened. */
function Steps({ call }) {
  const steps = [
    ['Called in', call.created_at],
    ['Officer sent', call.assigned_at],
    ['On the way', call.acknowledged_at],
    ['On scene', call.arrived_at],
    ['Cleared', call.cleared_at],
  ].filter(([, at]) => at);
  return (
    <ol className="call-log" style={{ marginTop: 6 }}>
      {steps.map(([label, at]) => (
        <li key={label} className="small">
          <span className="tiny muted">{fmtTime(at)}</span> {label}
        </li>
      ))}
    </ol>
  );
}

/**
 * Calls for service at the client's properties: what they asked for, what
 * the office raised on their behalf, where each one has got to, and how long
 * our officers took to get there.
 */
export default function PortalCalls({ sites }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    try {
      setData(await clientApi.get(`/client/calls?days=${days}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [days]);
  useEffect(() => {
    load();
    // Follow an open call without reloading the page.
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const cancel = async (id) => {
    try {
      await clientApi.post(`/client/calls/${id}/cancel`, {});
      toast.success('Call cancelled.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1>Calls</h1>
        <p className="muted">Ask for an officer now, and see how quickly we got there.</p>
      </div>

      <CallForm sites={sites} onSent={load} />

      {error && <Banner kind="danger" title="Your calls did not load">{error}</Banner>}
      {!data && !error ? (
        <LoadingPage label="Loading your calls" />
      ) : data ? (
        <div className="card">
          <div className="card-head">
            <h2 className="h3">Your calls</h2>
            <span className="small muted">{data.calls.length}</span>
          </div>
          <div className="card-body" style={{ paddingTop: 0 }}>
            <Segmented
              label="How far back"
              value={days}
              onChange={setDays}
              options={[
                { value: 7, label: '7 days' },
                { value: 30, label: '30 days' },
                { value: 90, label: '90 days' },
              ]}
            />
            {data.summary.avgMinutesToArrive != null && (
              <div className="small muted" style={{ marginTop: 8 }}>
                {data.summary.cleared} cleared · an officer on scene in {data.summary.avgMinutesToArrive} minutes on average
              </div>
            )}
          </div>
          {data.calls.length === 0 ? (
            <Empty icon="phone" title="No calls">
              Calls you raise here, and calls the office takes for your property, appear here.
            </Empty>
          ) : (
            <ul className="list">
              {data.calls.map((c) => (
                <li key={c.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className="strong small">{c.type_label}</span>
                      <Chip kind={STATUS_KIND[c.status]}>{c.status === 'open' ? 'Finding an officer' : c.status_label}</Chip>
                      {c.priority <= 2 && <Chip kind="warn">{c.priority_label}</Chip>}
                      {c.minutes_to_arrive != null && (
                        <Chip kind={c.minutes_to_arrive <= c.target_minutes ? 'ok' : ''}>On scene in {c.minutes_to_arrive} min</Chip>
                      )}
                    </div>
                    <div className="tiny muted" style={{ marginTop: 3 }}>
                      {c.site_name}
                      {c.location ? ` · ${c.location}` : ''} · {fmtDateTime(c.created_at)}
                      {c.raised_by_you ? ' · raised by you' : c.source === 'client' ? ' · raised by a colleague' : ' · taken by our office'}
                      {c.officer ? ` · ${c.officer}` : ''}
                    </div>
                    <div className="small" style={{ marginTop: 4 }}>{c.description}</div>
                    {c.open && <Steps call={c} />}
                    {c.outcome && (
                      <div className="small" style={{ marginTop: 6 }}>
                        <strong>{c.disposition_label}:</strong> {c.outcome}
                      </div>
                    )}
                    {c.cancel_reason && (
                      <div className="small muted" style={{ marginTop: 6 }}>
                        Cancelled: {c.cancel_reason}
                      </div>
                    )}
                  </div>
                  {c.open && c.status !== 'on_scene' && (
                    <button className="btn btn-sm btn-ghost" onClick={() => cancel(c.id)} aria-label={`Cancel the ${c.type_label.toLowerCase()} call`}>
                      Cancel
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
