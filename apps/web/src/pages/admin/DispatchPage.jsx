import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtTime } from '../../lib/format.js';
import { Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, Stat, useToast } from '../../components/ui.jsx';
import {
  CALL_TYPES,
  CALL_TYPE_LABEL,
  CALL_PRIORITIES,
  CALL_PRIORITY_LABEL,
  CALL_DISPOSITIONS,
  CALL_DISPOSITION_LABEL,
  CALL_TARGET_MINUTES,
} from '@shared/domain.js';

const PRIORITY_KIND = { 1: 'danger', 2: 'warn', 3: '' };
const STATUS_KIND = { open: 'danger', assigned: 'warn', en_route: 'info', on_scene: 'ok', cleared: 'ok', cancelled: '' };
const EVENT_LABEL = {
  raised: 'Raised', assigned: 'Sent to', reassigned: 'Re-sent to', acknowledged: 'Acknowledged', arrived: 'On scene',
  declined: 'Turned back', returned: 'Back on the board', cleared: 'Cleared', cancelled: 'Cancelled',
};
const mins = (m) => (m == null ? '--' : `${m} min`);

export function PriorityChip({ call }) {
  return <Chip kind={PRIORITY_KIND[call.priority]}>{call.priority_label || CALL_PRIORITY_LABEL[call.priority]}</Chip>;
}

/** Raise a call the office took by phone. */
function NewCall({ sites, posts, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    siteId: '', postId: '', callType: 'alarm', priority: 2, location: '', description: '', callerName: '', callerPhone: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const sitePosts = posts.filter((p) => String(p.site_id) === form.siteId);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const d = await api.post('/dispatch', {
        siteId: Number(form.siteId),
        postId: form.postId ? Number(form.postId) : null,
        callType: form.callType,
        priority: form.priority,
        location: form.location || null,
        description: form.description,
        callerName: form.callerName || null,
        callerPhone: form.callerPhone || null,
      });
      toast.success('Call raised. Now send it to an officer.');
      onSaved(d.call);
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New call"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.siteId || form.description.trim().length < 5}>
            {busy ? 'Raising...' : 'Raise call'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div>
          <div className="small strong" style={{ marginBottom: 6 }}>
            Priority
          </div>
          <Segmented
            label="Priority"
            value={form.priority}
            onChange={(v) => setForm((f) => ({ ...f, priority: v }))}
            options={CALL_PRIORITIES.map((p) => ({ value: p, label: `${CALL_PRIORITY_LABEL[p]} · ${CALL_TARGET_MINUTES[p]} min` }))}
          />
        </div>
        <div className="grid grid-2">
          <Field label="Site" required error={errors.siteId}>
            <select value={form.siteId} onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value, postId: '' }))}>
              <option value="">Pick a site</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Post" error={errors.postId}>
            <select value={form.postId} onChange={set('postId')} disabled={!form.siteId}>
              <option value="">The site as a whole</option>
              {sitePosts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What kind of call" error={errors.callType}>
            <select value={form.callType} onChange={set('callType')}>
              {CALL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CALL_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Where on the property" error={errors.location}>
            <input value={form.location} onChange={set('location')} maxLength={160} placeholder="e.g. Loading dock door 3" />
          </Field>
        </div>
        <Field label="What is happening" required error={errors.description}>
          <textarea rows={3} value={form.description} onChange={set('description')} maxLength={1000} />
        </Field>
        <div className="grid grid-2">
          <Field label="Caller" error={errors.callerName}>
            <input value={form.callerName} onChange={set('callerName')} maxLength={80} />
          </Field>
          <Field label="Callback number" error={errors.callerPhone}>
            <input type="tel" value={form.callerPhone} onChange={set('callerPhone')} maxLength={30} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/** Close a call from the desk: dealt with by phone, or cleared for an officer whose phone died. */
function ClearForm({ call, onDone }) {
  const toast = useToast();
  const [disposition, setDisposition] = useState(call.status === 'open' ? 'referred' : 'resolved');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const allowed = call.status === 'open' ? ['referred', 'nothing_found'] : CALL_DISPOSITIONS;
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/dispatch/${call.id}/clear`, { disposition, outcome });
      toast.success('Call cleared.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      <Field label="Outcome">
        <select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
          {allowed.map((d) => (
            <option key={d} value={d}>
              {CALL_DISPOSITION_LABEL[d]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What was found and done" hint={call.source === 'client' ? 'The client reads this, and is emailed it.' : 'The client reads this in the portal.'}>
        <textarea rows={2} value={outcome} onChange={(e) => setOutcome(e.target.value)} maxLength={1000} />
      </Field>
      <div>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || outcome.trim().length < 5}>
          {busy ? 'Clearing...' : 'Clear call'}
        </button>
      </div>
    </div>
  );
}

function CallDialog({ id, onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/dispatch/${id}`));
    } catch (err) {
      toast.error(err.message);
      onClose();
    }
  }, [id, toast, onClose]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const after = async () => {
    setClearing(false);
    setCancelling(false);
    await load();
    onChanged();
  };

  const send = async (officer) => {
    setBusy(officer.id);
    try {
      await api.post(`/dispatch/${id}/assign`, { userId: officer.id });
      toast.success(`Sent to ${officer.name}.`);
      await after();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    try {
      await api.post(`/dispatch/${id}/cancel`, { reason });
      toast.success('Call cancelled.');
      await after();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const c = data?.call;
  return (
    <Modal title={c ? `Call #${c.id}: ${c.type_label}` : 'Call'} wide onClose={onClose}>
      {!c ? (
        <div className="muted small">Loading...</div>
      ) : (
        <div className="stack">
          <div className="row wrap" style={{ gap: 6 }}>
            <PriorityChip call={c} />
            <Chip kind={STATUS_KIND[c.status]}>{c.status_label}</Chip>
            {c.source === 'client' && <Chip kind="info">From the client</Chip>}
            {c.timings.late && <Chip kind="danger">Past the {c.timings.target}-minute target</Chip>}
            {c.disposition_label && <Chip>{c.disposition_label}</Chip>}
          </div>
          <div>
            <div className="strong">
              {c.site_name}
              {c.post_name ? ` · ${c.post_name}` : ''}
            </div>
            <div className="small muted">{[c.location, c.address, c.city].filter(Boolean).join(' · ')}</div>
            <p style={{ margin: '8px 0 0' }}>{c.description}</p>
            <div className="tiny muted" style={{ marginTop: 4 }}>
              {c.source === 'client'
                ? `Raised in the portal by ${c.client_contact}${c.client_company ? ` (${c.client_company})` : ''}`
                : `Taken by ${c.created_by_name || 'the office'}`}
              {c.caller_name ? ` · caller ${c.caller_name}` : ''}
              {c.caller_phone ? ` · ` : ''}
              {c.caller_phone && <a href={`tel:${c.caller_phone}`}>{c.caller_phone}</a>}
            </div>
            {c.outcome && (
              <div className="small" style={{ marginTop: 6 }}>
                <strong>Outcome:</strong> {c.outcome}
              </div>
            )}
            {c.cancel_reason && (
              <div className="small" style={{ marginTop: 6 }}>
                <strong>Cancelled:</strong> {c.cancel_reason}
              </div>
            )}
          </div>

          <div className="grid grid-4">
            <Stat label="To send" value={mins(c.timings.toAssign)} />
            <Stat label="To acknowledge" value={mins(c.timings.toAcknowledge)} />
            <Stat label="To on scene" value={mins(c.timings.toArrive)} foot={`Target ${c.timings.target} min`} alert={c.timings.withinTarget === false} />
            <Stat label="On scene" value={mins(c.timings.onScene)} />
          </div>

          {c.open && (
            <section aria-labelledby="call-officers">
              <h3 id="call-officers" style={{ margin: '0 0 6px' }}>
                {c.status === 'open' ? 'Send it to' : 'Officers on duty'}
              </h3>
              {data.candidates.length === 0 ? (
                <Empty icon="users" title="Nobody is on duty right now" />
              ) : (
                <ul className="list">
                  {data.candidates.slice(0, 8).map((o) => (
                    <li key={o.id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="grow">
                        <div className="small strong">
                          {o.name}
                          {o.armed ? ' · armed' : ''}
                        </div>
                        <div className="tiny muted">
                          {o.same_site ? 'At this property' : o.site_name} · {o.post_name}
                          {o.distance_km != null ? ` · ${o.distance_km} km${o.position_from === 'post' ? ' (from post)' : ''}` : ''}
                        </div>
                      </div>
                      {o.busy && <Chip kind="warn">On another call</Chip>}
                      {o.on_break && <Chip kind="warn">On a {o.on_break} break</Chip>}
                      {o.assigned ? (
                        <Chip kind="ok">Has it</Chip>
                      ) : (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => send(o)}
                          disabled={busy != null || c.status === 'on_scene'}
                          aria-label={`Send call to ${o.name}`}
                        >
                          {busy === o.id ? 'Sending...' : c.assigned_to ? 'Re-send' : 'Send'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section aria-labelledby="call-log">
            <h3 id="call-log" style={{ margin: '0 0 6px' }}>
              Log
            </h3>
            <ol className="call-log">
              {data.events.map((e) => (
                <li key={e.id}>
                  <span className="tiny muted">{fmtTime(e.created_at)}</span>{' '}
                  <strong className="small">{EVENT_LABEL[e.kind] || e.kind}</strong>{' '}
                  <span className="small">
                    {['assigned', 'reassigned'].includes(e.kind) ? e.note : e.user_name || e.client_name || ''}
                    {['declined', 'returned', 'cancelled'].includes(e.kind) && e.note ? `: ${e.note}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {c.open && (
            <div className="row wrap" style={{ gap: 8 }}>
              {!clearing && !cancelling && (
                <>
                  <button className="btn btn-sm" onClick={() => setClearing(true)}>
                    Clear from the desk
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setCancelling(true)}>
                    Cancel call
                  </button>
                </>
              )}
            </div>
          )}
          {clearing && <ClearForm call={c} onDone={after} />}
          {cancelling && (
            <div className="stack-sm">
              <Field label="Why is it cancelled?">
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
              </Field>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-sm btn-danger" onClick={cancel} disabled={busy != null || reason.trim().length < 3}>
                  Cancel the call
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setCancelling(false)}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function CallRow({ call, onOpen }) {
  const t = call.timings;
  return (
    <li className="list-item" onClick={() => onOpen(call.id)} style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div className="row wrap" style={{ gap: 6 }}>
          <PriorityChip call={call} />
          <strong className="small">{call.type_label}</strong>
          <span className="small muted">
            {call.site_name}
            {call.location ? ` · ${call.location}` : ''}
          </span>
        </div>
        <div className="small" style={{ marginTop: 2 }}>
          {call.description}
        </div>
        <div className="tiny muted" style={{ marginTop: 2 }}>
          {fmtDateTime(call.created_at)}
          {call.source === 'client' ? ` · from ${call.client_contact || 'the client'}` : ''}
          {call.officer_name ? ` · ${call.officer_name}` : ''}
          {call.open ? ` · ${t.elapsed} min so far` : t.toArrive != null ? ` · on scene in ${t.toArrive} min` : ''}
        </div>
      </div>
      <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
        <Chip kind={STATUS_KIND[call.status]}>{call.status_label}</Chip>
        {t.late && <Chip kind="danger">Late</Chip>}
        {!call.open && t.withinTarget === false && <Chip kind="warn">Over target</Chip>}
        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onOpen(call.id); }} aria-label={`Open call ${call.id}`}>
          Open
        </button>
      </div>
    </li>
  );
}

/**
 * The dispatch board: every call still open, oldest waiting first, and the
 * recent closed ones with how long each took. Refreshes on its own.
 */
export default function DispatchPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'closed' ? 'closed' : 'active';
  const openId = params.get('call');
  const [data, setData] = useState(null);
  const [ref, setRef] = useState({ sites: [], posts: [] });
  const [raising, setRaising] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/dispatch?view=${view}&days=7`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { calls: [], summary: {} });
    }
  }, [view, toast]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    api.get('/reference').then(setRef, () => {});
  }, []);

  const openCall = useCallback(
    (id) => {
      const next = new URLSearchParams(params);
      if (id) next.set('call', String(id));
      else next.delete('call');
      setParams(next, { replace: true });
    },
    [params, setParams]
  );
  const closeCall = useCallback(() => openCall(null), [openCall]);

  if (!data) return <LoadingPage label="Loading dispatch" />;
  const s = data.summary;

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="eyebrow">Operations</div>
          <h1>Dispatch</h1>
          <p className="lead">Calls for service: who needs an officer, who is on the way, and how long it took.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setRaising(true)}>
          <Icon name="plus" size={16} /> New call
        </button>
      </div>

      <div className="grid grid-4">
        <Stat label="Waiting" value={s.waiting ?? 0} foot="Nobody sent yet" alert={s.waiting > 0} />
        <Stat label="Open" value={s.active ?? 0} foot="Sent, on the way or on scene" />
        <Stat label="Today" value={s.today ?? 0} foot={`${s.clearedToday ?? 0} cleared`} />
        <Stat
          label="To on scene today"
          value={s.avgArriveToday != null ? `${s.avgArriveToday} min` : '--'}
          foot={s.withinTargetToday != null ? `${s.withinTargetToday}% inside target` : 'Average'}
        />
      </div>

      <Segmented
        label="Which calls"
        value={view}
        onChange={(v) => setParams(v === 'closed' ? { view: 'closed' } : {}, { replace: true })}
        options={[
          { value: 'active', label: `Open ${s.active ?? ''}`.trim() },
          { value: 'closed', label: 'Closed, last 7 days' },
        ]}
      />

      <div className="card">
        {data.calls.length === 0 ? (
          <Empty icon="shield" title={view === 'active' ? 'No open calls' : 'No closed calls this week'}>
            {view === 'active' ? 'Calls raised here or by clients in the portal appear on this board.' : null}
          </Empty>
        ) : (
          <ul className="list call-list">
            {data.calls.map((c) => (
              <CallRow key={c.id} call={c} onOpen={openCall} />
            ))}
          </ul>
        )}
      </div>

      {raising && (
        <NewCall
          sites={ref.sites}
          posts={ref.posts}
          onClose={() => setRaising(false)}
          onSaved={(call) => {
            setRaising(false);
            load();
            openCall(call.id);
          }}
        />
      )}
      {openId && <CallDialog id={openId} onClose={closeCall} onChanged={load} />}
    </div>
  );
}
