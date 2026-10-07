import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDay, fmtRelative, fmtTime, toDateInput } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Stat, useToast } from '../../components/ui.jsx';

const EVERY_SECONDS = 15;
const STATE = {
  no_show: { label: 'No-show', kind: 'danger' },
  late: { label: 'Late', kind: 'warn' },
  covering: { label: 'Cover on the way', kind: 'info' },
  arrived: { label: 'Arrived late', kind: 'warn' },
  covered: { label: 'Covered', kind: 'ok' },
  missed: { label: 'Never covered', kind: 'danger' },
};
const STAGE_KIND = { late: 'warn', no_show: 'danger', arrived: 'ok', covered: 'ok' };
const TEXT_KIND = { sent: 'ok', skipped: 'warn', failed: 'danger', queued: '' };
const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`);
const tel = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

/** Monday of the week a shift falls in, for opening the schedule there. */
function weekOf(iso) {
  const d = new Date(iso);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateInput(d);
}

/** Desktop notifications, for a board left open in a background tab. Remembered per browser. */
function useDesktopNotices() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [on, setOn] = useState(() => {
    try {
      return supported && Notification.permission === 'granted' && localStorage.getItem('usc.attendance.notify') === '1';
    } catch {
      return false;
    }
  });
  const toggle = async () => {
    if (!supported) return;
    let next = !on;
    if (next && Notification.permission !== 'granted') next = (await Notification.requestPermission()) === 'granted';
    setOn(next);
    try {
      localStorage.setItem('usc.attendance.notify', next ? '1' : '0');
    } catch {
      /* private window: on for this visit only */
    }
  };
  const notify = useCallback((title, body) => {
    if (on && document.visibilityState !== 'visible') {
      try {
        new Notification(title, { body, tag: 'usc-attendance' });
      } catch {
        /* some browsers only allow these from a service worker */
      }
    }
  }, [on]);
  return { supported, on, toggle, notify };
}

/* ======================================================== the settings === */

function Toggle({ checked, onChange, disabled, children, hint }) {
  return (
    <label className="check" style={{ alignItems: 'flex-start' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>
        {children}
        {hint && <span className="tiny muted" style={{ display: 'block' }}>{hint}</span>}
      </span>
    </label>
  );
}

/**
 * What I hear about, and how. A phone number gets texts only once the code
 * sent to it has been typed back here.
 */
function SettingsDialog({ initial, rules, onClose, onSaved }) {
  const toast = useToast();
  const [settings, setSettings] = useState(initial);
  const [form, setForm] = useState({
    smsEnabled: initial.sms_enabled, pushEnabled: initial.push_enabled,
    onLate: initial.on_late, onNoShow: initial.on_no_show, onUpdate: initial.on_update,
  });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [shownCode, setShownCode] = useState(null);
  const [changing, setChanging] = useState(!initial.phone_verified);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () => act(async () => {
    const r = await api.post('/attendance/settings/phone', { phone });
    setSettings(r.settings);
    setShownCode(r.code || null);
    setCode('');
    toast.success(r.sent ? `A code is on its way to ${r.settings.pending_phone}.` : 'Your code is shown below.');
  });
  const verify = () => act(async () => {
    const r = await api.post('/attendance/settings/phone/verify', { code });
    setSettings(r.settings);
    setForm((f) => ({ ...f, smsEnabled: true }));
    setShownCode(null);
    setChanging(false);
    setPhone('');
    toast.success(`${r.settings.phone} is confirmed. Texts are on.`);
    onSaved(r.settings);
  });
  const remove = () => act(async () => {
    const r = await api.del('/attendance/settings/phone');
    setSettings(r.settings);
    setForm((f) => ({ ...f, smsEnabled: false }));
    setChanging(true);
    toast.success('Number removed. No more texts.');
    onSaved(r.settings);
  });
  const test = () => act(async () => {
    const r = await api.post('/attendance/settings/test');
    if (r.sent) toast.success(`Test text sent to ${settings.phone}.`);
    else toast.error(r.reason === 'not-configured' ? 'Recorded, but not sent: no text provider is set up yet.' : `Not sent: ${r.error || r.reason}.`);
  });
  const save = () => act(async () => {
    const r = await api.put('/attendance/settings', form);
    toast.success('Alert settings saved.');
    onSaved(r.settings);
    onClose();
  });

  const pending = settings.pending_phone && changing;
  return (
    <Modal
      title="Late and no-show alerts"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>Save</button>
        </>
      }
    >
      <div className="stack">
        <section className="stack-sm" aria-labelledby="alerts-phone">
          <h3 id="alerts-phone" className="small strong" style={{ margin: 0 }}>Text messages</h3>
          {settings.phone_verified && !changing ? (
            <div className="row-between wrap" style={{ gap: 8 }}>
              <div className="small">
                <Icon name="phone" size={14} /> <strong>{settings.phone}</strong> <Chip kind="ok">Confirmed</Chip>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={test} disabled={busy}>Send a test text</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setChanging(true)} disabled={busy}>Change number</button>
                <button className="btn btn-ghost btn-sm" onClick={remove} disabled={busy}>Remove</button>
              </div>
            </div>
          ) : pending ? (
            <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); verify(); }}>
              <Field label={`Code sent to ${settings.pending_phone}`} hint="Six digits. It expires in ten minutes.">
                <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </Field>
              {shownCode && (
                <Banner kind="info" title={`Your code is ${shownCode}`}>
                  No text provider is set up on this server, so the code is shown here instead of texted.
                </Banner>
              )}
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || code.length !== 6}>Confirm number</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setSettings((x) => ({ ...x, pending_phone: null })); setShownCode(null); }}>
                  Use a different number
                </button>
              </div>
            </form>
          ) : (
            <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
              <Field label="Mobile number" hint="We text a code to it; alerts go there once you type the code back. US numbers need no +1.">
                <input type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(904) 555-0100" />
              </Field>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10}>Text me a code</button>
                {settings.phone_verified && (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setChanging(false)}>Keep {settings.phone}</button>
                )}
              </div>
            </form>
          )}
        </section>

        <fieldset className="check-row plain">
          <legend className="small strong">How</legend>
          <div className="stack-sm">
            <Toggle checked={form.smsEnabled} onChange={set('smsEnabled')} disabled={!settings.phone_verified}
              hint={settings.phone_verified ? `To ${settings.phone}` : 'Add and confirm a number above first'}>
              Text me
            </Toggle>
            <Toggle checked={form.pushEnabled} onChange={set('pushEnabled')} hint="To the USA Security Connect app, on any phone you are signed in on">
              Notify the app
            </Toggle>
          </div>
        </fieldset>

        <fieldset className="check-row plain">
          <legend className="small strong">About</legend>
          <div className="stack-sm">
            <Toggle checked={form.onLate} onChange={set('onLate')} hint={`Not clocked in ${rules.lateGraceMinutes} minutes after the start`}>
              Officers running late
            </Toggle>
            <Toggle checked={form.onNoShow} onChange={set('onNoShow')} hint={`Not clocked in ${rules.noShowMinutes} minutes after the start`}>
              No-shows
            </Toggle>
            <Toggle checked={form.onUpdate} onChange={set('onUpdate')} hint="When the officer clocks in after all, or the shift is given to someone else">
              Updates on those
            </Toggle>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

/* ========================================================= the board === */

function Row({ o, focused }) {
  const st = STATE[o.state];
  const late = o.state === 'late' || o.state === 'no_show';
  return (
    <li className={`list-item handover${focused ? ' is-focused' : ''}`} id={`attendance-${o.shift_id}`} style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="grow stack-sm">
        <div className="row wrap" style={{ gap: 8 }}>
          <Chip kind={st.kind} dot={o.state === 'no_show'}>{st.label}</Chip>
          <Link className="small strong" to={`/admin/employees/${o.user_id}`}>{o.officer}</Link>
          {o.covered_from && <span className="tiny muted">for {o.covered_from}</span>}
        </div>
        <div className="small">
          {o.post_name}, <span className="muted">{o.site_name}</span>
        </div>
        <div className="tiny muted">
          {fmtDay(o.starts_at)}, due {fmtTime(o.starts_at)}
          {late && ` · not clocked in, ${mins(o.minutes_late)} after the start`}
          {o.state === 'covering' && ` · not clocked in yet`}
          {(o.state === 'arrived' || o.state === 'covered') && ` · clocked in ${fmtTime(o.clock_in_at)}, ${mins(o.minutes_late)} after the start`}
          {o.state === 'missed' && ` · shift ended ${fmtTime(o.ends_at)} with nobody on post`}
        </div>
        {o.timeline.length > 0 && (
          <ol className="row wrap tiny muted" style={{ gap: 6, listStyle: 'none', margin: 0, padding: 0 }} aria-label="What happened">
            {o.timeline.map((t, i) => (
              <li key={i}>
                {i > 0 && '→ '}
                {t.label} {fmtTime(t.at)}
                {t.stage === 'covered' && t.detail?.by ? ` (${t.detail.by})` : ''}
              </li>
            ))}
          </ol>
        )}
      </div>
      {(late || o.state === 'covering') && (
        <div className="row wrap handover-actions" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {o.phone && (
            <a className="btn btn-ghost btn-sm" href={tel(o.phone)} aria-label={`Call ${o.officer}`}>
              <Icon name="phone" size={14} /> Call
            </a>
          )}
          {late && (
            <Link className={`btn btn-sm ${o.state === 'no_show' ? 'btn-primary' : 'btn-ghost'}`}
              to={`/admin/schedule?week=${weekOf(o.starts_at)}&shift=${o.shift_id}`} aria-label={`Find cover for ${o.officer}'s shift`}>
              Find cover
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Officers who have not clocked in for a shift that has started, as it
 * happens: late after the grace period, a no-show after half an hour, and
 * then whether they turned up or someone covered. The same updates go out
 * as texts and app notifications to whoever has asked for them.
 */
export default function AttendancePage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const focus = Number(params.get('shift')) || null;
  const [data, setData] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [, tick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState(() => new Set());
  const lastId = useRef(null);
  const desktop = useDesktopNotices();
  const { notify } = desktop;

  const load = useCallback(async () => {
    try {
      const d = await api.get('/attendance');
      const newest = d.events[0]?.id || 0;
      if (lastId.current != null) {
        const arrived = d.events.filter((e) => e.id > lastId.current);
        if (arrived.length) {
          setFresh(new Set(arrived.map((e) => e.id)));
          for (const e of arrived.slice(0, 3).reverse()) {
            (e.stage === 'no_show' ? toast.error : toast.toast)(e.line);
            notify(e.label, e.line);
          }
        }
      }
      lastId.current = Math.max(lastId.current || 0, newest);
      setData(d);
      setUpdatedAt(Date.now());
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast, notify]);
  useEffect(() => {
    load();
    const t = setInterval(load, EVERY_SECONDS * 1000);
    const k = setInterval(() => tick((n) => n + 1), 5000);
    return () => {
      clearInterval(t);
      clearInterval(k);
    };
  }, [load]);
  useEffect(() => {
    if (data && focus) document.getElementById(`attendance-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [data, focus]);

  const c = data?.counts;
  const me = data?.settings;
  const ago = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null;
  return (
    <div className="page stack">
      <div className="page-head row-between wrap" style={{ marginBottom: 0, gap: 12 }}>
        <div>
          <div className="eyebrow">Operations</div>
          <h1>Late &amp; no-shows</h1>
          <p className="lead">
            Every shift that has started without its officer clocked in. Late after {data?.rules.lateGraceMinutes ?? 7} minutes, a no-show
            after {data?.rules.noShowMinutes ?? 30}, then whether they turned up or someone covered. This page updates itself, and the same
            updates go to your phone by text if you ask for them.
          </p>
        </div>
        <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
          <span className="small muted row" style={{ gap: 6 }}>
            <span className="dot dot-pulse" style={{ color: 'var(--ok)' }} aria-hidden="true" />
            Live{ago != null ? ` · updated ${ago < 5 ? 'just now' : `${ago}s ago`}` : ''}
          </span>
          {desktop.supported && (
            <button className="btn btn-ghost btn-sm" onClick={desktop.toggle} aria-pressed={desktop.on}>
              <Icon name="bell" size={14} /> {desktop.on ? 'Desktop alerts on' : 'Desktop alerts'}
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => setEditing(true)} disabled={!me}>
            <Icon name="phone" size={14} /> Text alerts
          </button>
        </div>
      </div>

      {!data ? (
        <LoadingPage label="Loading late and no-shows" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="No-shows" value={c.no_show} foot={`No clock-in ${data.rules.noShowMinutes} min after the start`} alert={c.no_show > 0} />
            <Stat label="Late" value={c.late} foot={`Past the ${data.rules.lateGraceMinutes}-minute grace`} alert={c.late > 0} />
            <Stat label="Cover on the way" value={c.covering} foot="Given to another officer" />
            <Stat label="Arrived late" value={c.arrived} foot={`And ${s(c.covered, 'shift')} covered, last 12 h`} />
          </div>

          <section className="card card-pad" aria-labelledby="alerts-me">
            <div className="row-between wrap" style={{ gap: 8 }}>
              <div className="stack-sm" style={{ gap: 2 }}>
                <h2 id="alerts-me" className="small strong" style={{ margin: 0 }}>Your alerts</h2>
                <div className="small muted">
                  {me.sms_enabled && me.phone_verified ? `Texts to ${me.phone}` : 'No texts'}
                  {me.push_enabled ? ' · app notifications' : ''}
                  {' · '}
                  {[me.on_late && 'late starts', me.on_no_show && 'no-shows', me.on_update && 'updates'].filter(Boolean).join(', ') || 'nothing'}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Change</button>
            </div>
            {!me.provider.configured && (
              <div className="tiny muted" style={{ marginTop: 8 }}>
                No text provider is set up on this server, so texts are written to the outbox below but not sent. An administrator adds a Twilio
                account to turn them on.
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="attendance-now">
            <div className="card-head">
              <h2 id="attendance-now" className="section-title" style={{ margin: 0 }}>Right now</h2>
              <span className="small muted">{s(data.open.length, 'shift')}</span>
            </div>
            {data.open.length === 0 ? (
              <Empty icon="check" title="Everyone due is on post">Every shift that has started has its officer clocked in.</Empty>
            ) : (
              <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.open.map((o) => <Row key={o.shift_id} o={o} focused={o.shift_id === focus} />)}
              </ul>
            )}
          </section>

          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <section className="card" aria-labelledby="attendance-feed">
              <div className="card-head">
                <h2 id="attendance-feed" className="section-title" style={{ margin: 0 }}>Updates</h2>
                <span className="small muted">Newest first</span>
              </div>
              {data.events.length === 0 ? (
                <Empty icon="clock" title="Nothing yet">Late starts and no-shows show here as they happen.</Empty>
              ) : (
                <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-live="polite" aria-relevant="additions">
                  {data.events.slice(0, 20).map((e) => (
                    <li key={e.id} className={`list-item${fresh.has(e.id) ? ' is-new' : ''}`} style={{ cursor: 'default', alignItems: 'flex-start' }}>
                      <div className="grow stack-sm" style={{ gap: 2 }}>
                        <div className="row wrap" style={{ gap: 6 }}>
                          <Chip kind={STAGE_KIND[e.stage]}>{e.label}</Chip>
                          <span className="tiny muted">{fmtDay(e.occurred_at)}, {fmtTime(e.occurred_at)}</span>
                        </div>
                        <div className="small">{e.line}</div>
                        <div className="tiny muted">{e.site_name}{e.texts ? ` · ${s(e.texts, 'text')}` : ''}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="stack">
              <section className="card" aria-labelledby="attendance-earlier">
                <div className="card-head">
                  <h2 id="attendance-earlier" className="section-title" style={{ margin: 0 }}>Earlier, last 12 hours</h2>
                  <span className="small muted">{s(data.resolved.length, 'shift')}</span>
                </div>
                {data.resolved.length === 0 ? (
                  <Empty icon="check" title="Nobody late today">No shift in the last twelve hours started without its officer.</Empty>
                ) : (
                  <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {data.resolved.map((o) => <Row key={o.shift_id} o={o} focused={o.shift_id === focus} />)}
                  </ul>
                )}
              </section>

              <section className="card" aria-labelledby="attendance-texts">
                <div className="card-head">
                  <h2 id="attendance-texts" className="section-title" style={{ margin: 0 }}>Texts</h2>
                  <span className="small muted">Latest {data.texts.length}</span>
                </div>
                {data.texts.length === 0 ? (
                  <Empty icon="phone" title="No texts yet">Texts to supervisors and administrators show here, with whether they went.</Empty>
                ) : (
                  <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {data.texts.slice(0, 8).map((t) => (
                      <li key={t.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                        <div className="grow stack-sm" style={{ gap: 2 }}>
                          <div className="row wrap" style={{ gap: 6 }}>
                            <span className="small strong">{t.to_name || 'Unknown'}</span>
                            <span className="tiny muted">{t.to}</span>
                            <Chip kind={TEXT_KIND[t.status]}>{t.status === 'skipped' ? 'Not sent' : t.status === 'sent' ? 'Sent' : t.status === 'failed' ? 'Failed' : 'Sending'}</Chip>
                            <span className="tiny muted">{fmtRelative(t.created_at)}</span>
                          </div>
                          <div className="tiny" style={{ overflowWrap: 'anywhere' }}>{t.body}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </>
      )}

      {editing && me && (
        <SettingsDialog
          initial={me}
          rules={data.rules}
          onClose={() => setEditing(false)}
          onSaved={(settings) => setData((d) => ({ ...d, settings }))}
        />
      )}
    </div>
  );
}
