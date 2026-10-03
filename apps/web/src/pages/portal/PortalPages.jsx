/**
 * The four screens a client contact actually uses.
 *
 * They share a site filter and a date window, so they live together rather
 * than passing the same two pieces of state through a router.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { clientApi } from '../../lib/api.js';
import { fmtDate, fmtDateShort, fmtDateTime, fmtDay, fmtMoney, fmtRange, fmtTime, fmtHours, toDateInput } from '../../lib/format.js';
import {
  Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Progress, Segmented, Spinner, StatusChip, Stat,
} from '../../components/ui.jsx';
import { AuthedImage } from '../../components/AuthedImage.jsx';
import { InvoiceSheet, printInvoice } from '../../components/InvoiceSheet.jsx';
import { PrintableIncident, printIncident } from '../../components/IncidentSheet.jsx';

/* ------------------------------------------------------------ shared -- */

/** Load a portal endpoint, with the loading and error states spelled out. */
function usePortal(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await clientApi.get(path));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}

function Loaded({ loading, error, data, reload, children, label }) {
  if (loading && !data) return <LoadingPage label={label} />;
  if (error) {
    return (
      <Banner
        kind="danger"
        title="That did not load"
        action={
          <button className="btn btn-sm btn-ghost" onClick={reload}>
            Try again
          </button>
        }
      >
        {error}
      </Banner>
    );
  }
  return children;
}

/**
 * A client portal gets opened on a phone far more often than the staff console
 * does, and a wide table pushes the one column they care about - did somebody
 * turn up - behind a horizontal scroll. Narrow screens get cards instead.
 */
function useNarrow(maxWidth = 680) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${maxWidth}px)`).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [maxWidth]);
  return narrow;
}

/** A site picker, hidden entirely from a contact who only has one property. */
function SitePicker({ sites, value, onChange }) {
  if (sites.length < 2) return null;
  return (
    <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
      <label htmlFor="site">Property</label>
      <select id="site" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">All properties</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function DaysPicker({ value, onChange }) {
  return (
    <Segmented
      label="Time range"
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={[
        { value: '7', label: '7 days' },
        { value: '30', label: '30 days' },
        { value: '90', label: '90 days' },
      ]}
    />
  );
}

const query = (siteId, days) =>
  `?days=${days}${siteId ? `&siteId=${siteId}` : ''}`;

/**
 * How a shift should read to the client.
 *
 * A shift nobody has clocked into is only a failure once it is over. Calling a
 * future shift "not covered" in red would have clients ringing the office
 * about posts that are simply not due yet.
 */
function coverageStatus(shift, now = Date.now()) {
  if (shift.covered) {
    return shift.late ? { kind: 'warn', label: 'Late start' } : { kind: 'ok', label: 'Covered' };
  }
  if (new Date(shift.ends_at).getTime() < now) return { kind: 'danger', label: 'Not covered' };
  if (new Date(shift.starts_at).getTime() <= now) return { kind: 'warn', label: 'Awaiting clock-in' };
  return { kind: '', label: 'Scheduled' };
}

/* ------------------------------------------------- building issues -- */

const ISSUE_TEXT = {
  lighting: 'Lighting', door_lock: 'Door or lock', leak: 'Leak', damage: 'Damage', hazard: 'Hazard',
  cleanliness: 'Cleanliness', equipment: 'Equipment', other: 'Other',
};
const ISSUE_STATE = { open: ['warn', 'New'], acknowledged: ['info', 'Seen'], fixed: ['ok', 'Fixed'] };

/**
 * What our officers found wrong with the building, for the client to act on:
 * "seen it" tells the officers it is in hand, "fixed" closes it. A note goes
 * back to the officer on post.
 */
function BuildingIssues() {
  const { data, error, loading, reload } = usePortal('/client/issues', []);
  const [answering, setAnswering] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const answer = async (issue, status) => {
    setBusy(true);
    try {
      await clientApi.post(`/client/issues/${issue.id}/status`, { status, note: note || null });
      setMessage(status === 'fixed' ? 'Marked fixed. Thank you.' : 'Marked as seen. The officers on post will see your note.');
      setAnswering(null);
      setNote('');
      reload();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error || (loading && !data)) return null;
  const open = data?.issues.filter((i) => i.status !== 'fixed') || [];
  const fixed = data?.issues.filter((i) => i.status === 'fixed') || [];

  return (
    <section className="card">
      <div className="card-head">
        <h2>Building issues</h2>
        <span className="small muted">
          {open.length} open{fixed.length ? ` · ${fixed.length} fixed this month` : ''}
        </span>
      </div>
      {message && (
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Banner kind="info">{message}</Banner>
        </div>
      )}
      {open.length === 0 ? (
        <div className="card-pad">
          <Empty icon="building" title="Nothing waiting on you">
            When our officers find a light out, a door that will not lock or a hazard, it appears here.
          </Empty>
        </div>
      ) : (
        <ul className="list">
          {open.map((i) => {
            const [kind, label] = ISSUE_STATE[i.status] || ['', i.status];
            return (
              <li key={i.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="strong small">{ISSUE_TEXT[i.category] || i.category}</span>
                    {i.priority === 'urgent' && <Chip kind="danger">Urgent</Chip>}
                    <Chip kind={kind}>{label}</Chip>
                  </div>
                  {i.location_text && <div className="tiny muted">{i.location_text}</div>}
                  <div className="small" style={{ marginTop: 3 }}>{i.description}</div>
                  {i.client_note && <div className="tiny muted" style={{ marginTop: 3 }}>Your note: {i.client_note}</div>}
                  <div className="tiny muted" style={{ marginTop: 3 }}>
                    Reported {fmtDateTime(i.created_at)}
                    {sitesLabel(i)}
                  </div>
                  {answering === i.id && (
                    <div className="stack-sm" style={{ marginTop: 8 }}>
                      <label className="small strong" htmlFor={`issue-note-${i.id}`}>
                        Note for the officers (optional)
                      </label>
                      <input id={`issue-note-${i.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                      <div className="row wrap" style={{ gap: 6 }}>
                        {i.status === 'open' && (
                          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => answer(i, 'acknowledged')}>
                            Seen - it is in hand
                          </button>
                        )}
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => answer(i, 'fixed')}>
                          It is fixed
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {answering !== i.id && (
                  <button
                    className="btn btn-sm btn-navy"
                    onClick={() => {
                      setAnswering(i.id);
                      setNote('');
                      setMessage('');
                    }}
                  >
                    Update
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
const sitesLabel = (i) => (i.site_name ? ` · ${i.site_name}` : '');

/* ------------------------------------------------------- feedback -- */

/** A month's rating per property, and our replies to earlier ones. */
function RateUs({ sites }) {
  const { data, reload } = usePortal('/client/feedback', []);
  const [siteId, setSiteId] = useState(sites[0]?.id);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const current = data?.feedback.find((f) => f.site_id === Number(siteId) && f.period === data.period);
  useEffect(() => {
    setRating(current?.rating || 0);
    setComment(current?.comment || '');
  }, [current?.id, current?.rating, current?.comment]);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await clientApi.post('/client/feedback', { siteId: Number(siteId), rating, comment: comment || null });
      setMessage('Thank you - your account manager sees this straight away.');
      reload();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };
  const replies = data?.feedback.filter((f) => f.response).slice(0, 2) || [];

  return (
    <section className="card">
      <div className="card-head">
        <h2>How are we doing this month?</h2>
        {current && <Chip kind="ok">Rated</Chip>}
      </div>
      <form className="card-pad stack-sm" onSubmit={send}>
        {sites.length > 1 && (
          <select aria-label="Property" value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ maxWidth: 360 }}>
            {sites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        <div className="row" role="radiogroup" aria-label="Rating" style={{ gap: 4 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              className="star-btn"
              onClick={() => setRating(n)}
              style={{ color: n <= rating ? '#c98a00' : 'var(--line-2)' }}
            >
              ★
            </button>
          ))}
          <span className="small muted" style={{ marginLeft: 8 }}>
            {rating ? ['', 'Poor', 'Below what we expect', 'OK', 'Good', 'Excellent'][rating] : 'Choose a rating'}
          </span>
        </div>
        <label className="small strong" htmlFor="feedback-comment">
          {rating && rating <= 2 ? 'What went wrong? (needed)' : 'Anything to add? (optional)'}
        </label>
        <textarea id="feedback-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
        <div className="row-between wrap">
          <span className="small muted" aria-live="polite">{message}</span>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !rating || (rating <= 2 && comment.trim().length < 3)}>
            {busy ? 'Sending...' : current ? 'Update rating' : 'Send rating'}
          </button>
        </div>
        {replies.map((f) => (
          <div key={f.id} className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <strong>Our reply</strong> on your {f.period} rating for {f.site_name}: {f.response}
          </div>
        ))}
      </form>
    </section>
  );
}

/* -------------------------------------------------- commendations -- */

/** Thank an officer for something they did at the property. */
function CommendOfficer() {
  const { data, reload } = usePortal('/client/commendations', []);
  const [choice, setChoice] = useState('');
  const [category, setCategory] = useState('customer_service');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!data || data.officers.length === 0) return null;
  const [officerId, siteId] = choice ? choice.split(':').map(Number) : [null, null];

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const res = await clientApi.post('/client/commendations', { officerId, siteId, category, message: text.trim() });
      setMessage(`Thank you - ${res.commendation.officer.split(' ')[0]} will see it, and so will their supervisor.`);
      setText('');
      setChoice('');
      reload();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };
  const multiSite = new Set(data.officers.map((o) => o.site_id)).size > 1;

  return (
    <section className="card" id="commend">
      <div className="card-head">
        <h2>Commend an officer</h2>
        {data.commendations.length > 0 && <Chip kind="ok">{data.commendations.length} sent</Chip>}
      </div>
      <form className="card-pad stack-sm" onSubmit={send}>
        <p className="small muted" style={{ margin: 0 }}>
          Someone did something worth a thank-you? The officer reads it, and it goes on their record.
        </p>
        <div className="grid grid-2">
          <Field label="Officer">
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose an officer</option>
              {data.officers.map((o) => (
                <option key={`${o.id}:${o.site_id}`} value={`${o.id}:${o.site_id}`}>
                  {o.name}
                  {multiSite ? ` - ${o.site_name}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="For">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {data.categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="What they did">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
        </Field>
        <div className="row-between wrap">
          <span className="small muted" aria-live="polite">{message}</span>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !choice || text.trim().length < 10}>
            {busy ? 'Sending...' : 'Send the commendation'}
          </button>
        </div>
        {data.commendations.slice(0, 2).map((c) => (
          <div key={c.id} className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <strong>{c.officer}</strong> · {c.category_label} · {fmtDate(c.created_at)}
            <div className="muted">{c.message}</div>
          </div>
        ))}
      </form>
    </section>
  );
}

/* ---------------------------------------------------- site contacts -- */

const BLANK_CONTACT = { name: '', role: '', phone: '', email: '', notes: '', afterHours: false };

/** The people our officers call at the property - the client keeps it current. */
function OfficerContacts() {
  const { data, reload } = usePortal('/client/contacts', []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(BLANK_CONTACT);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const open = (siteId, c) => {
    setEditing({ siteId, id: c?.id });
    setForm(c ? { name: c.name, role: c.role, phone: c.phone || '', email: c.email || '', notes: c.notes || '', afterHours: c.after_hours } : BLANK_CONTACT);
    setError('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    const body = { ...form, phone: form.phone || null, email: form.email || null };
    try {
      if (editing.id) await clientApi.patch(`/client/contacts/${editing.id}`, body);
      else await clientApi.post('/client/contacts', { ...body, siteId: editing.siteId });
      setEditing(null);
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c) => {
    try {
      await clientApi.del(`/client/contacts/${c.id}`);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!data) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Who our officers call</h2>
        <span className="small muted">Keep this current - officers see it on post</span>
      </div>
      {error && !editing && (
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Banner kind="danger">{error}</Banner>
        </div>
      )}
      {data.sites.map((site) => (
        <div key={site.id}>
          {data.sites.length > 1 && <div className="card-pad small strong" style={{ paddingBottom: 0 }}>{site.name}</div>}
          <ul className="list">
            {site.contacts.map((c) => (
              <li key={c.id} className="list-item" style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="strong small">{c.role}</span>
                    {c.after_hours && <Chip kind="navy">After hours</Chip>}
                  </div>
                  <div className="small">
                    {c.name}
                    {c.phone ? ` · ${c.phone}` : ''}
                    {c.email ? ` · ${c.email}` : ''}
                  </div>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => open(site.id, c)}>
                  Edit
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => remove(c)} aria-label={`Remove ${c.name}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="card-pad" style={{ paddingTop: 8 }}>
            <button className="btn btn-sm btn-ghost" onClick={() => open(site.id)}>
              <Icon name="plus" size={15} /> Add a contact
            </button>
          </div>
        </div>
      ))}
      {editing && (
        <Modal
          title={editing.id ? 'Edit contact' : 'Add a contact'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save} disabled={busy || form.name.trim().length < 2 || form.role.trim().length < 2}>
                {busy ? 'Saving...' : 'Save'}
              </button>
            </>
          }
        >
          <div className="stack">
            {error && <Banner kind="danger">{error}</Banner>}
            <div className="grid grid-2">
              <Field label="Name" required>
                <input value={form.name} onChange={set('name')} maxLength={120} />
              </Field>
              <Field label="Who they are" required hint="Property manager, maintenance.">
                <input value={form.role} onChange={set('role')} maxLength={80} />
              </Field>
            </div>
            <div className="grid grid-2">
              <Field label="Phone">
                <input type="tel" value={form.phone} onChange={set('phone')} maxLength={40} />
              </Field>
              <Field label="Email">
                <input type="email" value={form.email} onChange={set('email')} maxLength={160} />
              </Field>
            </div>
            <Field label="Notes for officers">
              <input value={form.notes} onChange={set('notes')} maxLength={300} />
            </Field>
            <label className="row small">
              <input type="checkbox" checked={form.afterHours} onChange={set('afterHours')} style={{ width: 'auto' }} />
              Reachable after hours
            </label>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ---------------------------------------------------------- overview -- */

/**
 * What each property pays for against what we worked, week by week: the
 * number a client checks their invoice against.
 */
function AgreementHours() {
  const { data } = usePortal('/client/agreement', []);
  const sites = (data?.sites || []).filter((s) => s.agreement);
  if (!sites.length) return null;
  return (
    <section className="card" aria-labelledby="agreement-title">
      <div className="card-head">
        <h2 id="agreement-title">Hours against your agreement</h2>
      </div>
      <div className="card-pad stack">
        {sites.map((s) => {
          const target = s.agreement.weekly_hours;
          const max = Math.max(target, ...s.weeks.map((w) => w.hours), 1);
          return (
            <div key={s.id} className="stack-sm">
              <div className="row-between wrap" style={{ gap: 6 }}>
                <span className="strong">{s.name}</span>
                <span className="small muted">
                  {target} h a week
                  {s.agreement.ends_on ? ` · runs to ${fmtDate(`${s.agreement.ends_on}T12:00:00`)}` : ''}
                </span>
              </div>
              <ul className="agreement-weeks">
                {s.weeks.map((w) => {
                  const pct = target ? Math.round((w.hours / target) * 100) : null;
                  return (
                    <li key={w.week_of}>
                      <span className="small nowrap">Week of {fmtDateShort(`${w.week_of}T12:00:00`)}</span>
                      <span className="ag-bar" aria-hidden="true">
                        <span className="ag-filled" style={{ width: `${(w.hours / max) * 100}%` }} />
                        <span className="ag-target" style={{ left: `${(target / max) * 100}%` }} />
                      </span>
                      <span className="small num nowrap">
                        {w.hours} h{pct != null ? ` · ${pct}%` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="tiny muted">{s.rostered_hours} h rostered for the next 7 days.</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function PortalOverview({ sites }) {
  const { data, error, loading, reload } = usePortal('/client/overview?days=7', []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coverage at a glance</h1>
          <p className="muted">
            {sites.length === 1 ? sites[0].name : `${sites.length} properties`} &middot; last 7 days
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reload} disabled={loading}>
          {loading ? <Spinner dark /> : <Icon name="refresh" size={16} />} Refresh
        </button>
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading your coverage">
        {data && (
          <div className="stack">
            <BuildingIssues />

            <section className="card">
              <div className="card-head">
                <h2>On post right now</h2>
                <Chip kind={data.onPost.length ? 'ok' : ''} dot={data.onPost.length > 0}>
                  {data.onPost.length} on duty
                </Chip>
              </div>
              {data.onPost.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="shield" title="Nobody is clocked in">
                    This is normal outside your contracted hours.
                  </Empty>
                </div>
              ) : (
                <ul className="list">
                  {data.onPost.map((o) => (
                    <li key={o.id} className="list-item">
                      <div className="grow">
                        <div className="strong">{o.officer_name}</div>
                        <div className="small muted">
                          {o.post_name} &middot; {o.site_name}
                        </div>
                      </div>
                      <div className="nowrap small muted">since {fmtTime(o.clock_in_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="grid grid-4">
              <Stat
                label="Shifts covered"
                value={
                  data.summary.coveragePercent == null ? '--' : `${data.summary.coveragePercent}%`
                }
                foot={`${data.summary.shiftsCovered} of ${data.summary.shiftsScheduled} scheduled`}
                alert={data.summary.coveragePercent != null && data.summary.coveragePercent < 95}
              />
              <Stat label="Hours on site" value={data.summary.hoursOnSite} foot="last 7 days" />
              <Stat
                label="Patrols walked"
                value={data.summary.patrolRuns}
                foot={`${data.summary.checkpointsScanned} of ${data.summary.checkpointsTotal} checkpoints`}
              />
              <Stat
                label="Incidents"
                value={data.summary.incidents}
                foot={
                  data.summary.seriousIncidents > 0
                    ? `${data.summary.seriousIncidents} high or critical`
                    : 'none serious'
                }
                alert={data.summary.seriousIncidents > 0}
              />
            </div>

            {data.summary.supervisorVisits > 0 && (
              <Banner kind="info" title="Supervisor checks">
                A field supervisor visited your property {data.summary.supervisorVisits} time
                {data.summary.supervisorVisits === 1 ? '' : 's'} in the last 7 days.
              </Banner>
            )}

            <AgreementHours />
            <RateUs sites={sites} />
            <CommendOfficer />
            <OfficerContacts />

            <section className="card">
              <div className="card-head">
                <h2>Coming up</h2>
              </div>
              {data.upcoming.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="calendar" title="Nothing scheduled" />
                </div>
              ) : (
                <ul className="list">
                  {data.upcoming.map((s) => (
                    <li key={s.id} className="list-item">
                      <div className="grow">
                        <div className="strong">{s.post_name}</div>
                        <div className="small muted">
                          {s.site_name} &middot; {fmtDate(s.starts_at)}, {fmtRange(s.starts_at, s.ends_at)}
                        </div>
                      </div>
                      {s.officer_name ? (
                        <Chip>{s.officer_name}</Chip>
                      ) : (
                        // Honest about an unfilled post: the client will see
                        // it on the day anyway, and a surprise reads worse.
                        <Chip kind="warn">Being assigned</Chip>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Loaded>
    </div>
  );
}

/* ---------------------------------------------------------- coverage -- */

/** Worked shifts, or the schedule ahead. */
export function PortalCoverage({ sites }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'upcoming' ? 'upcoming' : 'worked';
  const switcher = (
    <Segmented
      label="Coverage view"
      value={view}
      onChange={(v) => setParams(v === 'upcoming' ? { view: v } : {}, { replace: true })}
      options={[
        { value: 'worked', label: 'Worked' },
        { value: 'upcoming', label: 'Coming up' },
      ]}
    />
  );
  return view === 'upcoming' ? <UpcomingCoverage sites={sites} switcher={switcher} /> : <CoverageRecord sites={sites} switcher={switcher} />;
}

/** The next week or two at their properties, day by day. */
function UpcomingCoverage({ sites, switcher }) {
  const [siteId, setSiteId] = useState(null);
  const [days, setDays] = useState(7);
  const qs = new URLSearchParams({ days: String(days) });
  if (siteId) qs.set('siteId', String(siteId));
  const { data, error, loading, reload } = usePortal(`/client/schedule?${qs}`, [siteId, days]);
  const byDay = [];
  for (const s of data?.shifts || []) {
    const key = new Date(s.starts_at).toDateString();
    const last = byDay[byDay.length - 1];
    if (last && last.key === key) last.shifts.push(s);
    else byDay.push({ key, day: s.starts_at, shifts: [s] });
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coming up</h1>
          <p className="muted">Who is booked on each post over the days ahead, and anything we are still arranging.</p>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        {switcher}
        <SitePicker sites={sites} value={siteId} onChange={setSiteId} />
        <Segmented
          label="How far ahead"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: 'Next 7 days' },
            { value: 14, label: 'Next 14 days' },
          ]}
        />
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading the schedule">
        {data &&
          (data.shifts.length === 0 ? (
            <div className="card card-pad">
              <Empty icon="calendar" title="Nothing scheduled in this period" />
            </div>
          ) : (
            <div className="stack">
              <p className="small muted" style={{ margin: 0 }}>
                {data.summary.assigned} of {data.summary.total} shift{data.summary.total === 1 ? '' : 's'} booked
                {data.summary.total > data.summary.assigned ? `; ${data.summary.total - data.summary.assigned} still being arranged` : ''}.
                {data.summary.confirmed > 0 &&
                  ` ${data.summary.confirmed} confirmed by the officer, who has told us they will be there.`}
              </p>
              {byDay.map((d) => (
                <section key={d.key} className="card" aria-label={fmtDay(d.day)}>
                  <div className="card-head">
                    <h2 className="small strong" style={{ margin: 0 }}>{fmtDay(d.day)}</h2>
                  </div>
                  <ul className="list">
                    {d.shifts.map((s) => (
                      <li key={s.id} className="list-item" style={{ cursor: 'default' }}>
                        <div className="grow">
                          <div className="strong small">
                            {s.post_name}
                            {sites.length > 1 ? <span className="muted"> &middot; {s.site_name}</span> : null}
                          </div>
                          <div className="tiny muted">
                            {fmtRange(s.starts_at, s.ends_at)}
                            {s.armed ? ' · armed' : ''}
                          </div>
                        </div>
                        {s.assigned ? (
                          <span className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <span className="small">{s.officer_name}</span>
                            {s.confirmed && (
                              <Chip kind="ok">
                                <Icon name="check" size={12} /> Confirmed
                              </Chip>
                            )}
                          </span>
                        ) : (
                          <Chip kind="warn">Being arranged</Chip>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ))}
      </Loaded>
    </div>
  );
}

function CoverageRecord({ sites, switcher }) {
  const [siteId, setSiteId] = useState(null);
  const [days, setDays] = useState(30);
  const narrow = useNarrow();
  const { data, error, loading, reload } = usePortal(`/client/coverage${query(siteId, days)}`, [siteId, days]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coverage record</h1>
          <p className="muted">Every scheduled shift, and who stood it.</p>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        {switcher}
        <SitePicker sites={sites} value={siteId} onChange={setSiteId} />
        <DaysPicker value={days} onChange={setDays} />
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading coverage">
        {data &&
          (data.shifts.length === 0 ? (
            <div className="card card-pad">
              <Empty icon="calendar" title="No shifts in this period" />
            </div>
          ) : narrow ? (
            <div className="card">
              <ul className="list">
                {data.shifts.map((s) => {
                  const status = coverageStatus(s);
                  return (
                    <li key={s.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <div className="strong">{s.post_name}</div>
                        <div className="tiny muted">
                          {fmtDate(s.starts_at)} &middot; {fmtRange(s.starts_at, s.ends_at)}
                          {s.armed ? ' · armed' : ''}
                        </div>
                        <div className="small" style={{ marginTop: 3 }}>
                          {s.officer_name || <span className="muted">Unassigned</span>}
                          {s.clock_in_at && (
                            <span className="muted">
                              {' '}
                              &middot; {fmtTime(s.clock_in_at)}
                              {s.clock_out_at ? `-${fmtTime(s.clock_out_at)}` : ' onwards'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <Chip kind={status.kind}>{status.label}</Chip>
                        {s.hours_worked != null && (
                          <div className="tiny muted" style={{ marginTop: 3 }}>
                            {fmtHours(s.hours_worked)}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Post</th>
                    <th scope="col">Officer</th>
                    <th scope="col">Scheduled</th>
                    <th scope="col">On post</th>
                    <th scope="col">Hours</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shifts.map((s) => {
                    const status = coverageStatus(s);
                    return (
                      <tr key={s.id}>
                        <td className="nowrap">{fmtDate(s.starts_at)}</td>
                        <td>
                          <div className="strong">{s.post_name}</div>
                          <div className="tiny muted">
                            {s.site_name}
                            {s.armed ? ' · armed post' : ''}
                          </div>
                        </td>
                        <td>{s.officer_name || <span className="muted">Unassigned</span>}</td>
                        <td className="nowrap">{fmtRange(s.starts_at, s.ends_at)}</td>
                        <td className="nowrap">
                          {s.clock_in_at ? (
                            <>
                              {fmtTime(s.clock_in_at)}
                              {s.clock_out_at ? ` - ${fmtTime(s.clock_out_at)}` : ' - on post'}
                            </>
                          ) : (
                            <span className="muted">--</span>
                          )}
                        </td>
                        <td className="nowrap">{s.hours_worked == null ? '--' : fmtHours(s.hours_worked)}</td>
                        <td>
                          <Chip kind={status.kind}>{status.label}</Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </Loaded>
    </div>
  );
}

/* ----------------------------------------------------------- patrols -- */

function PatrolDialog({ runId, onClose }) {
  const { data, error, loading, reload } = usePortal(`/client/patrols/${runId}`, [runId]);

  return (
    <Modal title="Patrol record" onClose={onClose} wide>
      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading the patrol">
        {data && (
          <div className="stack">
            <dl className="kv">
              <dt>Patrol</dt>
              <dd>{data.run.tour_name}</dd>
              <dt>Officer</dt>
              <dd>{data.run.officer_name}</dd>
              <dt>Started</dt>
              <dd>{fmtDateTime(data.run.started_at)}</dd>
              <dt>Finished</dt>
              <dd>{data.run.completed_at ? fmtDateTime(data.run.completed_at) : 'Still in progress'}</dd>
            </dl>

            <ul className="timeline">
              {data.checkpoints.map((c) => (
                <li key={c.id} className="timeline-item">
                  <div className="row-between">
                    <div className="grow">
                      <div className="strong">{c.name}</div>
                      {c.instructions && <div className="tiny muted">{c.instructions}</div>}
                      {c.skip_reason && (
                        <div className="tiny" style={{ color: 'var(--warn-700, #92400e)' }}>
                          Skipped: {c.skip_reason}
                        </div>
                      )}
                    </div>
                    <div className="nowrap" style={{ textAlign: 'right' }}>
                      <StatusChip value={c.status} />
                      <div className="tiny muted">{c.scanned_at ? fmtTime(c.scanned_at) : '--'}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Loaded>
    </Modal>
  );
}

export function PortalPatrols({ sites }) {
  const [siteId, setSiteId] = useState(null);
  const [days, setDays] = useState(7);
  const [open, setOpen] = useState(null);
  const narrow = useNarrow();
  const { data, error, loading, reload } = usePortal(`/client/patrols${query(siteId, days)}`, [siteId, days]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Patrol proof</h1>
          <p className="muted">Each round walked, and every checkpoint reached.</p>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        <SitePicker sites={sites} value={siteId} onChange={setSiteId} />
        <DaysPicker value={days} onChange={setDays} />
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading patrols">
        {data &&
          (data.runs.length === 0 ? (
            <div className="card card-pad">
              <Empty icon="route" title="No patrols in this period">
                Patrol rounds walked at your property will be listed here.
              </Empty>
            </div>
          ) : narrow ? (
            <div className="card">
              <ul className="list">
                {data.runs.map((r) => (
                  <li key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      <div className="strong">{r.tour_name}</div>
                      <div className="tiny muted">
                        {fmtDateTime(r.started_at)} &middot; {r.officer_name}
                      </div>
                      <div className="small" style={{ marginTop: 4 }}>
                        {r.scanned} of {r.checkpoints} checkpoints
                        {r.skipped > 0 ? ` · ${r.skipped} skipped` : ''}
                      </div>
                      <Progress label="Checkpoints scanned on this round" value={r.scanned} max={r.checkpoints} ok={r.scanned === r.checkpoints} />
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <StatusChip value={r.status} />
                      <div>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(r.id)}>
                          View
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Round</th>
                    <th scope="col">Officer</th>
                    <th scope="col">Checkpoints</th>
                    <th scope="col">Status</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDateTime(r.started_at)}</td>
                      <td>
                        <div className="strong">{r.tour_name}</div>
                        <div className="tiny muted">{r.site_name}</div>
                      </td>
                      <td>{r.officer_name}</td>
                      <td style={{ minWidth: 140 }}>
                        <div className="small">
                          {r.scanned} of {r.checkpoints}
                          {r.skipped > 0 ? ` · ${r.skipped} skipped` : ''}
                        </div>
                        <Progress label="Checkpoints scanned on this round" value={r.scanned} max={r.checkpoints} ok={r.scanned === r.checkpoints} />
                      </td>
                      <td>
                        <StatusChip value={r.status} />
                      </td>
                      <td>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(r.id)}>
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Loaded>

      {open && <PatrolDialog runId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* --------------------------------------------------------- incidents -- */

function IncidentDialog({ id, onClose }) {
  const { data, error, loading, reload } = usePortal(`/client/incidents/${id}`, [id]);

  return (
    <Modal
      title="Incident report"
      onClose={onClose}
      wide
      footer={
        data && (
          <button className="btn btn-ghost" onClick={printIncident}>
            <Icon name="print" size={16} /> Print / save PDF
          </button>
        )
      }
    >
      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading the report">
        {data && (
          <div className="stack">
            <PrintableIncident incident={data.incident} actions={data.actions || []} photos={data.photos.length} />
            <div className="row" style={{ gap: 8 }}>
              <Chip kind="navy">{data.incident.ref_number}</Chip>
              <StatusChip value={data.incident.severity} />
              <StatusChip value={data.incident.status} />
              {data.incident.police_notified && <Chip kind="danger">Police notified</Chip>}
            </div>

            <dl className="kv">
              <dt>When</dt>
              <dd>{fmtDateTime(data.incident.occurred_at)}</dd>
              <dt>Where</dt>
              <dd>
                {data.incident.site_name}
                {data.incident.post_name ? ` · ${data.incident.post_name}` : ''}
                {data.incident.location_text ? ` · ${data.incident.location_text}` : ''}
              </dd>
              <dt>Reported by</dt>
              <dd>{data.incident.officer_name || '--'}</dd>
              {data.incident.category && (
                <>
                  <dt>Category</dt>
                  <dd>{data.incident.category}</dd>
                </>
              )}
              {data.incident.police_report_number && (
                <>
                  <dt>Police report</dt>
                  <dd className="mono">{data.incident.police_report_number}</dd>
                </>
              )}
            </dl>

            <div>
              <h3 className="small strong">What happened</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{data.incident.what_happened}</p>
            </div>

            {data.incident.resolution && (
              <div>
                <h3 className="small strong">How it was resolved</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{data.incident.resolution}</p>
              </div>
            )}

            {data.actions?.length > 0 && (
              <div>
                <h3 className="small strong">What we are doing about it</h3>
                <ul className="client-actions">
                  {data.actions.map((a) => (
                    <li key={a.id}>
                      <span className={a.status === 'done' ? 'done' : ''}>{a.title}</span>{' '}
                      {a.status === 'done' ? (
                        <Chip kind="ok">Done{a.done_at ? ` ${fmtDate(a.done_at)}` : ''}</Chip>
                      ) : (
                        <Chip kind="info">In hand{a.due_on ? `, due ${fmtDate(a.due_on)}` : ''}</Chip>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.incident.people_notified && (
              <div>
                <h3 className="small strong">Who was notified</h3>
                <p>{data.incident.people_notified}</p>
              </div>
            )}

            {data.photos.length > 0 && (
              <div>
                <h3 className="small strong">Photographs</h3>
                <div className="photo-grid">
                  {data.photos.map((p) => (
                    <figure key={p.id}>
                      {/* Served through the API so the file stays behind auth. */}
                      <AuthedImage
                        client
                        src={`/client/incidents/${data.incident.id}/photos/${p.id}`}
                        alt={p.caption || p.original_name || 'Incident photograph'}
                      />
                      {p.caption && <figcaption className="tiny muted">{p.caption}</figcaption>}
                    </figure>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Loaded>
    </Modal>
  );
}

export function PortalIncidents({ sites }) {
  const [siteId, setSiteId] = useState(null);
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState(null);
  const narrow = useNarrow();
  const { data, error, loading, reload } = usePortal(`/client/incidents${query(siteId, days)}`, [siteId, days]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="muted">Everything reported at your property.</p>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        <SitePicker sites={sites} value={siteId} onChange={setSiteId} />
        <DaysPicker value={days} onChange={setDays} />
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading incidents">
        {data &&
          (data.incidents.length === 0 ? (
            <div className="card card-pad">
              <Empty icon="alert" title="Nothing reported in this period">
                A quiet property is a good result.
              </Empty>
            </div>
          ) : narrow ? (
            <div className="card">
              <ul className="list">
                {data.incidents.map((i) => (
                  <li key={i.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      <div className="row wrap" style={{ gap: 6 }}>
                        <span className="mono small strong">{i.ref_number}</span>
                        <StatusChip value={i.severity} />
                        <StatusChip value={i.status} />
                      </div>
                      <div className="tiny muted" style={{ marginTop: 3 }}>
                        {fmtDateTime(i.occurred_at)}
                        {i.location_text ? ` · ${i.location_text}` : ''}
                        {i.police_notified ? ' · police notified' : ''}
                      </div>
                      <button className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={() => setOpen(i.id)}>
                        Read {i.photo_count > 0 ? `(${i.photo_count} photo${i.photo_count === 1 ? '' : 's'})` : ''}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">When</th>
                    <th scope="col">Where</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Status</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.incidents.map((i) => (
                    <tr key={i.id}>
                      <td className="mono nowrap">{i.ref_number}</td>
                      <td className="nowrap">{fmtDateTime(i.occurred_at)}</td>
                      <td>
                        <div>{i.site_name}</div>
                        <div className="tiny muted">
                          {[i.post_name, i.location_text].filter(Boolean).join(' · ') || i.category}
                        </div>
                      </td>
                      <td>
                        <StatusChip value={i.severity} />
                      </td>
                      <td>
                        <StatusChip value={i.status} />
                        {i.police_notified && (
                          <div className="tiny muted" style={{ marginTop: 3 }}>
                            Police notified
                          </div>
                        )}
                      </td>
                      <td>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(i.id)}>
                          Read {i.photo_count > 0 ? `(${i.photo_count} photo${i.photo_count === 1 ? '' : 's'})` : ''}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Loaded>

      {open && <IncidentDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ---------------------------------------------------------- invoices -- */

/** Questions about one invoice: what was asked, what we said, and a form to ask another. */
function InvoiceQuestions({ invoiceId, lines, queries, onChange }) {
  const [lineId, setLineId] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const openCount = queries.filter((q) => q.status === 'open').length;

  const ask = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await clientApi.post(`/client/invoices/${invoiceId}/queries`, {
        lineId: lineId ? Number(lineId) : null,
        question,
      });
      setQuestion('');
      setLineId('');
      onChange(d.queries);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="invoice-questions" aria-labelledby="invoice-questions-title">
      <h3 id="invoice-questions-title" className="small strong" style={{ margin: '0 0 6px' }}>
        Questions about this invoice
      </h3>
      {queries.length > 0 && (
        <ul className="list" style={{ marginBottom: 10 }}>
          {queries.map((q) => (
            <li key={q.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  {q.status === 'open' ? <Chip kind="warn">Waiting for our answer</Chip> : <Chip kind="ok">Answered</Chip>}
                  {q.line_description && <span className="tiny muted">{q.line_description}</span>}
                </div>
                <div className="small" style={{ marginTop: 4 }}>{q.question}</div>
                <div className="tiny muted">
                  {q.asked_by || 'You'}, {fmtDateTime(q.created_at)}
                </div>
                {q.answer && (
                  <div className="invoice-answer small">
                    <strong>Our answer:</strong> {q.answer}
                    <div className="tiny muted">{fmtDateTime(q.answered_at)}</div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {openCount >= 3 ? (
        <p className="small muted">Three questions are waiting on this invoice. We will answer those before taking another.</p>
      ) : (
        <form className="stack-sm" onSubmit={ask}>
          <Field label="About">
            <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">The whole invoice</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.description}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Your question" error={error || undefined} hint="Your account manager answers here and by email.">
            <textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} />
          </Field>
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || question.trim().length < 10}>
              {busy ? 'Sending...' : 'Ask about this invoice'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function InvoiceDialog({ id, onClose }) {
  const { data, error, loading, reload } = usePortal(`/client/invoices/${id}`, [id]);
  const [queries, setQueries] = useState(null);
  useEffect(() => setQueries(data?.queries ?? null), [data]);

  return (
    <Modal
      title={data ? `Invoice ${data.invoice.number}` : 'Invoice'}
      onClose={onClose}
      wide
      footer={
        data && (
          <button className="btn btn-ghost" onClick={printInvoice}>
            <Icon name="clipboard" size={16} /> Print / save PDF
          </button>
        )
      }
    >
      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading the invoice">
        {data && (
          <div className="stack">
            {data.invoice.overdue_days > 0 && (
              <Banner kind="warn">This invoice is {data.invoice.overdue_days} days past its due date.</Banner>
            )}
            {/* The same document the account manager sends, so they cannot differ. */}
            <InvoiceSheet invoice={data.invoice} lines={data.lines} site={data.invoice} />
            <InvoiceQuestions invoiceId={data.invoice.id} lines={data.lines} queries={queries || data.queries || []} onChange={setQueries} />
          </div>
        )}
      </Loaded>
    </Modal>
  );
}

export function PortalInvoices() {
  const [open, setOpen] = useState(null);
  const { data, error, loading, reload } = usePortal('/client/invoices', []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="muted">Billed from the hours on the coverage record.</p>
        </div>
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading invoices">
        {data && (
          <div className="stack">
            {data.outstandingCents > 0 && (
              <Banner kind="info" title="Outstanding">
                {fmtMoney(data.outstandingCents)} is currently outstanding across{' '}
                {data.invoices.filter((i) => i.status === 'sent').length} invoice
                {data.invoices.filter((i) => i.status === 'sent').length === 1 ? '' : 's'}.
              </Banner>
            )}

            {data.invoices.length === 0 ? (
              <div className="card card-pad">
                <Empty icon="clipboard" title="No invoices yet">
                  Invoices appear here once your account manager issues them.
                </Empty>
              </div>
            ) : (
              <div className="card">
                <ul className="list">
                  {data.invoices.map((i) => (
                    <li key={i.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <div className="row wrap" style={{ gap: 6 }}>
                          <span className="mono small strong">{i.number}</span>
                          <StatusChip value={i.status} />
                          {i.overdue_days > 0 && <Chip kind="danger">{i.overdue_days}d overdue</Chip>}
                          {i.open_queries > 0 && <Chip kind="warn">Question waiting</Chip>}
                        </div>
                        <div className="tiny muted" style={{ marginTop: 3 }}>
                          {i.site_name} &middot; {fmtDate(i.period_start)} to {fmtDate(i.period_end)}
                          {i.due_on ? ` · due ${fmtDate(i.due_on)}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="strong">{fmtMoney(i.total_cents)}</div>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(i.id)}>
                          View
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Loaded>

      {open && <InvoiceDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* --------------------------------------------------------------- DAR -- */

const VIOLATION_TEXT = {
  fire_lane: 'Fire lane', no_permit: 'No permit', accessible: 'Accessible bay', blocking: 'Blocking',
  abandoned: 'Abandoned vehicle', reserved: 'Reserved space', other: 'Other',
};
const ACTION_TEXT = { warning: 'warning left', tagged: 'tagged', booted: 'booted', towed: 'towed' };

export function PortalReport({ sites }) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? null);
  const [date, setDate] = useState(toDateInput(new Date()));
  const { data, error, loading, reload } = usePortal(
    `/client/dar?siteId=${siteId}&date=${date}`,
    [siteId, date]
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Daily activity report</h1>
          <p className="muted">The same document your account manager reviews.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn btn-ghost btn-sm" to="/portal/monthly">
            <Icon name="calendar" size={16} /> Monthly report
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>
            <Icon name="download" size={16} /> Print / save PDF
          </button>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        {sites.length > 1 && (
          <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
            <label htmlFor="darSite">Property</label>
            <select id="darSite" value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ maxWidth: 200, marginBottom: 0 }}>
          <label htmlFor="darDate">Date</label>
          <input
            id="darDate"
            type="date"
            value={date}
            max={toDateInput(new Date())}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Building the report">
        {data && (
          <div className="stack">
            <div className="card card-pad">
              <h2 style={{ marginTop: 0 }}>{data.site.name}</h2>
              <p className="muted small" style={{ marginBottom: 0 }}>
                {[data.site.address, data.site.city, data.site.state].filter(Boolean).join(', ')}
                <br />
                {fmtDate(data.date)} &middot; {fmtHours(data.totalHours)} on site
              </p>
            </div>

            <section className="card">
              <div className="card-head">
                <h2>Who was on post</h2>
              </div>
              {data.coverage.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="clock" title="No officer clocked in on this date" />
                </div>
              ) : (
                <ul className="list">
                  {data.coverage.map((c, i) => (
                    <li key={i} className="list-item">
                      <div className="grow">
                        <div className="strong">{c.officer_name}</div>
                        <div className="small muted">{c.post_name}</div>
                      </div>
                      <div className="nowrap small">
                        {fmtTime(c.clock_in_at)} - {c.clock_out_at ? fmtTime(c.clock_out_at) : 'on post'}
                        {c.hours != null && <span className="muted"> · {fmtHours(c.hours)}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Patrols</h2>
              </div>
              {data.patrols.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="route" title="No patrols recorded on this date" />
                </div>
              ) : (
                <ul className="list">
                  {data.patrols.map((p) => (
                    <li key={p.id} className="list-item">
                      <div className="grow">
                        <div className="strong">{p.tour_name}</div>
                        <div className="small muted">
                          {fmtTime(p.started_at)}
                          {p.completed_at ? ` - ${fmtTime(p.completed_at)}` : ' - in progress'}
                        </div>
                      </div>
                      <div className="nowrap small">
                        {p.scanned} of {p.checkpoints} checkpoints
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Incidents</h2>
                <Chip kind={data.incidents.length ? 'warn' : 'ok'}>{data.incidents.length}</Chip>
              </div>
              {data.incidents.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="alert" title="Nothing reported on this date" />
                </div>
              ) : (
                <ul className="list">
                  {data.incidents.map((i) => (
                    <li key={i.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <div className="row" style={{ gap: 8 }}>
                          <span className="mono small">{i.ref_number}</span>
                          <StatusChip value={i.severity} />
                        </div>
                        <div className="small" style={{ marginTop: 4 }}>
                          {i.what_happened}
                        </div>
                        {i.resolution && <div className="tiny muted">Resolved: {i.resolution}</div>}
                      </div>
                      <div className="nowrap small muted">{fmtTime(i.occurred_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.activity?.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <h2>Activity log</h2>
                  <span className="small muted">{data.activity.length} entries</span>
                </div>
                <ul className="list">
                  {data.activity.map((a) => (
                    <li key={a.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                      <div className="nowrap small strong" style={{ width: 62 }}>{fmtTime(a.occurred_at)}</div>
                      <div className="grow">
                        <div className="small">{a.body}</div>
                        <div className="tiny muted">{a.officer_name}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.issues?.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <h2>Building issues reported</h2>
                  <span className="small muted">{data.issues.length}</span>
                </div>
                <ul className="list">
                  {data.issues.map((i) => (
                    <li key={i.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                      <div className="grow">
                        <div className="strong small">
                          {ISSUE_TEXT[i.category] || i.category}
                          {i.location_text ? <span className="muted"> · {i.location_text}</span> : null}
                        </div>
                        <div className="small">{i.description}</div>
                      </div>
                      <Chip kind={(ISSUE_STATE[i.status] || [''])[0]}>{(ISSUE_STATE[i.status] || ['', i.status])[1]}</Chip>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="card">
              <div className="card-head">
                <h2>Visitors</h2>
                <span className="small muted">
                  {data.visitors?.length || 0} signed in
                  {data.visitorsOnSiteNow ? ` · ${data.visitorsOnSiteNow} inside now` : ''}
                </span>
              </div>
              {!data.visitors?.length ? (
                <div className="card-pad">
                  <Empty icon="users" title="No visitors logged on this date" />
                </div>
              ) : (
                <ul className="list">
                  {data.visitors.map((v) => (
                    <li key={v.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                      <div className="grow">
                        <div className="strong small">
                          {v.full_name}
                          {v.company ? <span className="muted"> · {v.company}</span> : null}
                        </div>
                        <div className="small">
                          {v.purpose}
                          {v.host ? ` · for ${v.host}` : ''}
                        </div>
                        {(v.vehicle_plate || v.vehicle_desc) && (
                          <div className="tiny muted">
                            {v.vehicle_plate ? <span className="mono">{v.vehicle_plate}</span> : null}
                            {v.vehicle_desc ? ` ${v.vehicle_desc}` : ''}
                          </div>
                        )}
                      </div>
                      <div className="nowrap small muted" style={{ textAlign: 'right' }}>
                        {fmtTime(v.arrived_at)}
                        <div className="tiny">{v.departed_at ? `to ${fmtTime(v.departed_at)}` : 'still inside'}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.vehicles?.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <h2>Parking enforcement</h2>
                  <span className="small muted">{data.vehicles.length}</span>
                </div>
                <ul className="list">
                  {data.vehicles.map((v) => (
                    <li key={v.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                      <div className="grow">
                        <div className="strong small">
                          <span className="mono">{v.plate}</span>
                          {v.vehicle_desc ? <span className="muted"> · {v.vehicle_desc}</span> : null}
                        </div>
                        <div className="small">
                          {VIOLATION_TEXT[v.violation] || v.violation} · {ACTION_TEXT[v.action] || v.action}
                        </div>
                        {v.location_text && <div className="tiny muted">{v.location_text}</div>}
                      </div>
                      <div className="nowrap small muted">{fmtTime(v.occurred_at)}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.visits.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <h2>Supervisor visits</h2>
                </div>
                <ul className="list">
                  {data.visits.map((v, i) => (
                    <li key={i} className="list-item">
                      <div className="grow">
                        <div className="strong">{v.post_name || 'Site visit'}</div>
                        {v.note && <div className="small muted">{v.note}</div>}
                      </div>
                      <div className="nowrap small muted">{fmtTime(v.visited_at)}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Loaded>
    </div>
  );
}
