import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { getPosition, geoBody } from '../../lib/geo.js';
import { fmtTime, fmtDay, fmtRange, fmtCountdown, fmtRelative } from '../../lib/format.js';
import {
  Icon, Banner, Chip, StatusChip, Modal, Field, SlideToAction,
  LoadingPage, useToast, Empty,
} from '../../components/ui.jsx';
import { formatDuration, toHours } from '@shared/domain.js';
import GpsPanel from '../../components/GpsPanel.jsx';

/* ----------------------------------------------------------- post orders -- */

/**
 * Standing orders the officer has not yet acknowledged. When a supervisor
 * changes them, this is the first thing the officer sees on the home screen
 * until they confirm they have read the new version.
 */
function PostOrdersCard({ onDuty }) {
  const toast = useToast();
  const [orders, setOrders] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.get('/post-log').then((d) => alive && setOrders(d.orders || null), () => {});
    return () => {
      alive = false;
    };
  }, [onDuty]);
  if (!orders || orders.acked_at) return null;
  const ack = async () => {
    setBusy(true);
    try {
      const d = await api.post(`/post-log/orders/${orders.id}/ack`);
      setOrders(d.orders);
      toast.success('Post orders acknowledged.');
    } catch (err) {
      toast.error(err.message);
      if (err.status === 409) api.get('/post-log').then((d) => setOrders(d.orders || null), () => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card-pad stack" aria-labelledby="orders-title" style={{ borderLeft: '4px solid var(--warn)' }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="lead-icon" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>
          <Icon name="clipboard" size={19} />
        </div>
        <div className="grow">
          <h3 id="orders-title" style={{ margin: 0 }}>
            {orders.version > 1 ? 'Your post orders have changed' : 'Read your post orders'}
          </h3>
          <div className="tiny muted">
            Version {orders.version}
            {orders.author_name ? `, from ${orders.author_name}` : ''}, {fmtDay(orders.created_at)}
          </div>
        </div>
        <Chip kind="warn">Unread</Chip>
      </div>
      {orders.change_note && orders.version > 1 && (
        <div className="small">
          <strong>What changed:</strong> {orders.change_note}
        </div>
      )}
      <div className="small" style={{ whiteSpace: 'pre-line', color: 'var(--ink-3)', maxHeight: 220, overflowY: 'auto' }}>
        {orders.body}
      </div>
      <button className="btn btn-primary" onClick={ack} disabled={busy}>
        {busy ? 'Saving...' : 'I have read these orders'}
      </button>
    </section>
  );
}

/* ------------------------------------------------------------ post log -- */

/**
 * The post's pass-down and visitors at a glance. Shown before the shift too,
 * so the officer can read what the last shift left before they arrive.
 */
function PostLogCard({ onDuty }) {
  const [log, setLog] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/post-log').then((d) => alive && setLog(d), () => {});
    return () => {
      alive = false;
    };
  }, [onDuty]);
  if (!log?.post) return null;
  const inside = log.visitors?.onSite?.length || 0;
  const urgent = log.passdown.some((n) => !n.mine && !n.acked_at && n.priority === 'important');
  return (
    <Link className="card card-pad row" to="/post-log" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="lead-icon" style={urgent ? { background: 'var(--danger-bg)', color: 'var(--danger)' } : undefined}>
        <Icon name="clipboard" size={19} />
      </div>
      <div className="grow">
        <div className="strong small">Post log</div>
        <div className="tiny muted">
          {log.unacked ? `${log.unacked} pass-down note${log.unacked === 1 ? '' : 's'} to read` : 'Pass-down all read'}
          {log.onDuty ? ` · ${inside} visitor${inside === 1 ? '' : 's'} on site` : ''}
        </div>
      </div>
      {log.unacked > 0 && <Chip kind={urgent ? 'danger' : 'warn'}>{log.unacked} new</Chip>}
      <Icon name="chevron" size={16} />
    </Link>
  );
}

/* --------------------------------------------------------- site contacts -- */

/** Who to call at this site, one tap from the home screen. */
function SiteContactsCard({ onDuty }) {
  const [site, setSite] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/post-log/site').then((d) => alive && setSite(d), () => {});
    return () => {
      alive = false;
    };
  }, [onDuty]);
  if (!site?.post || !site.contacts?.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Site contacts</h3>
        <span className="small muted">{site.post.site_name}</span>
      </div>
      <ul className="list">
        {site.contacts.map((c) => (
          <li key={c.id} className="list-item" style={{ cursor: 'default' }}>
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="strong small">{c.role}</span>
                {c.after_hours && <Chip kind="navy">After hours</Chip>}
              </div>
              <div className="small">{c.name}</div>
              {c.notes && <div className="tiny muted">{c.notes}</div>}
            </div>
            {c.phone ? (
              <a className="btn btn-sm btn-ghost" href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} aria-label={`Call ${c.role}, ${c.name}`}>
                <Icon name="phone" size={15} /> {c.phone}
              </a>
            ) : c.email ? (
              <a className="btn btn-sm btn-ghost" href={`mailto:${c.email}`}>
                Email
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------- check-in prompt -- */

function CheckInPrompt({ checkIn, onAnswered }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(checkIn.seconds_remaining);

  useEffect(() => {
    setLeft(checkIn.seconds_remaining);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [checkIn.id, checkIn.seconds_remaining]);

  const answer = async () => {
    setBusy(true);
    try {
      const fix = await getPosition({ timeout: 8000 });
      const res = await api.post('/timeclock/check-in', { checkId: checkIn.id, ...geoBody(fix) });
      toast.success(res.status === 'late' ? 'Check-in recorded (late).' : 'Check-in recorded. Stay safe.');
      onAnswered();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const overdue = checkIn.is_overdue;

  return (
    <div className={`card card-pad`} style={{ borderColor: overdue ? '#f3c9c3' : 'var(--line)' }}>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div className="row">
          <Icon name="shield" size={20} style={{ color: overdue ? 'var(--danger)' : 'var(--navy-700)' }} />
          <h3>Status check-in {overdue ? 'overdue' : 'due'}</h3>
        </div>
        <Chip kind={overdue ? 'danger' : 'warn'}>{fmtCountdown(left)} left</Chip>
      </div>
      <p className="small muted">
        Confirm you are safe and still on post. Missing a check-in raises an alert with your supervisor.
      </p>
      <button className="btn btn-primary btn-lg btn-block" onClick={answer} disabled={busy}>
        <Icon name="check" size={18} />
        {busy ? 'Sending...' : "I'm on post and OK"}
      </button>
    </div>
  );
}

/* ------------------------------------------------- outside-fence dialog -- */

function OverrideDialog({ detail, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Clock in from here?"
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={reason.trim().length < 5 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
              } finally {
                setBusy(false);
              }
            }}
          >
            Clock in anyway
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner kind="warn" title="You are not at the post location">
          {detail?.distance != null
            ? `Your phone reports you are about ${detail.distance}m away. The limit for this post is ${detail.radius}m.`
            : 'Your location could not be confirmed.'}
        </Banner>
        <Field
          label="Why are you clocking in from here?"
          hint="This goes to your supervisor with the clock-in record."
          required
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Relieving at the north gate; the console is inside the far building."
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- page -- */

export default function HomePage() {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState(null);
  const [override, setOverride] = useState(null);
  const [tick, setTick] = useState(0);
  const pendingClockIn = useRef(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get('/timeclock/status'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep "time on post" honest without hammering the API.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // Warm up a GPS fix so the slider does not stall when it is pulled.
  useEffect(() => {
    getPosition({ timeout: 9000 }).then(setFix);
  }, [status?.onDuty]);

  const clockIn = async (overrideReason) => {
    setBusy(true);
    try {
      const current = fix?.ok ? fix : await getPosition({ timeout: 9000 });
      setFix(current);
      const res = await api.post('/timeclock/clock-in', {
        ...geoBody(current),
        method: 'gps',
        shiftId: status?.shift?.id,
        postId: status?.shift?.post_id,
        overrideReason,
      });
      setOverride(null);
      toast.success(
        res.lateMinutes > 0
          ? `Clocked in. You are ${res.lateMinutes} minutes late - this is recorded.`
          : 'Clocked in. Have a safe shift.'
      );
      await load();
    } catch (err) {
      // The server asks for a reason when the officer is outside the geofence.
      if (err.status === 409 && (err.details?.code === 'outside_geofence' || err.details?.code === 'no_fix')) {
        pendingClockIn.current = true;
        setOverride(err.details);
      } else {
        toast.error(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const clockOut = async () => {
    setBusy(true);
    try {
      const current = await getPosition({ timeout: 9000 });
      const res = await api.post('/timeclock/clock-out', geoBody(current));
      toast.success(`Clocked out. ${formatDuration(res.minutesWorked)} on post.`);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingPage label="Checking your post" />;
  if (!status) return <Empty icon="alert" title="Could not load your post" />;

  const { onDuty, entry, shift, nextShift, lastEntry, checkIn, weekMinutes } = status;
  const post = entry || shift;

  return (
    <div className="page stack">
      {/* ---------------------------------------------------- greeting -- */}
      <div className="row-between">
        <div>
          <div className="page-head">
            <div className="eyebrow">{fmtDay(new Date())}</div>
            <h1>
              {new Date().getHours() < 12
                ? 'Good morning'
                : new Date().getHours() < 18
                  ? 'Good afternoon'
                  : 'Good evening'}
              , {user.first_name}
            </h1>
          </div>
        </div>
      </div>

      {checkIn?.is_open && <CheckInPrompt checkIn={checkIn} onAnswered={load} />}

      {/* Changed orders come before anything else on post. */}
      <PostOrdersCard onDuty={onDuty} />

      {/* -------------------------------------------------- post card -- */}
      <div className="card">
        <div className="card-head">
          <div className="row">
            <Icon name="pin" size={18} style={{ color: 'var(--brand-600)' }} />
            <h3>{onDuty ? 'Current post' : shift ? 'Your next post' : 'No post assigned'}</h3>
          </div>
          {onDuty && (
            <Chip kind="ok" dot>
              On post
            </Chip>
          )}
        </div>

        <div className="card-body stack">
          {post ? (
            <>
              <div>
                <div className="strong" style={{ fontSize: '1.08rem' }}>
                  {post.post_name}
                  {post.post_code && <span className="muted small mono"> &middot; {post.post_code}</span>}
                </div>
                <div className="small muted">
                  {post.site_name}
                  {post.address ? ` - ${post.address}, ${post.city} ${post.state}` : ''}
                </div>
              </div>

              <dl className="kv">
                {(shift || entry?.shift_starts_at) && (
                  <>
                    <dt>Scheduled</dt>
                    <dd>
                      {fmtRange(shift?.starts_at || entry.shift_starts_at, shift?.ends_at || entry.shift_ends_at)}
                      <span className="muted"> ({fmtDay(shift?.starts_at || entry.shift_starts_at)})</span>
                    </dd>
                  </>
                )}
                {onDuty && (
                  <>
                    <dt>Clocked in</dt>
                    <dd>
                      {fmtTime(entry.clock_in_at)}{' '}
                      <span className="muted">
                        ({formatDuration(
                          Math.round((Date.now() - new Date(entry.clock_in_at).getTime()) / 60000) + tick * 0
                        )}{' '}
                        on post)
                      </span>
                    </dd>
                    <dt>Location check</dt>
                    <dd>
                      <StatusChip value={entry.clock_in_geofence} />
                    </dd>
                    {checkIn && !checkIn.is_open && (
                      <>
                        <dt>Next check-in</dt>
                        <dd>
                          {fmtTime(checkIn.due_at)} <span className="muted">({fmtRelative(checkIn.due_at)})</span>
                        </dd>
                      </>
                    )}
                  </>
                )}
                {!onDuty && lastEntry && (
                  <>
                    <dt>Last clock-out</dt>
                    <dd>
                      {fmtDay(lastEntry.clock_out_at)} at {fmtTime(lastEntry.clock_out_at)}
                    </dd>
                  </>
                )}
              </dl>

              {post.instructions && (
                <details>
                  <summary className="strong small" style={{ cursor: 'pointer', color: 'var(--navy-700)' }}>
                    Officer instructions
                  </summary>
                  <div className="small" style={{ whiteSpace: 'pre-line', marginTop: 8, color: 'var(--ink-3)' }}>
                    {post.instructions}
                  </div>
                </details>
              )}
            </>
          ) : (
            <Banner kind="info" title="Nothing scheduled right now">
              {nextShift
                ? `Your next shift is ${fmtDay(nextShift.starts_at)} at ${fmtTime(nextShift.starts_at)}, ${nextShift.post_name}.`
                : 'Contact dispatch if you believe you should be on post.'}
            </Banner>
          )}

          {/* GPS readiness, so an officer is never surprised at clock-in. */}
          {!onDuty && (
            <div className="small row" style={{ color: fix?.ok ? 'var(--ok)' : 'var(--warn)' }}>
              <Icon name="pin" size={15} />
              {fix == null
                ? 'Checking GPS...'
                : fix.ok
                  ? `GPS ready (accurate to about ${fix.accuracy}m)`
                  : fix.message}
            </div>
          )}

          {(post || onDuty) && (
            <SlideToAction
              label={onDuty ? 'Slide to clock out' : 'Slide to clock in'}
              variant={onDuty ? 'out' : 'in'}
              busy={busy}
              onConfirm={onDuty ? clockOut : () => clockIn()}
            />
          )}
        </div>
      </div>

      <GpsPanel status={status} />

      {/* ------------------------------------------------ quick actions -- */}
      <div className="grid grid-2">
        <Link className="card card-pad row" to="/incidents/new" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="lead-icon" style={{ background: 'var(--brand-100)', color: 'var(--brand-600)' }}>
            <Icon name="alert" size={19} />
          </div>
          <div className="grow">
            <div className="strong small">Report an incident</div>
            <div className="tiny muted">Photos, cost recovery, notifications</div>
          </div>
          <Icon name="chevron" size={16} />
        </Link>

        <Link className="card card-pad row" to="/tours" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="lead-icon">
            <Icon name="route" size={19} />
          </div>
          <div className="grow">
            <div className="strong small">Start a tour</div>
            <div className="tiny muted">Scan checkpoints and complete tasks</div>
          </div>
          <Icon name="chevron" size={16} />
        </Link>
      </div>

      <PostLogCard onDuty={onDuty} />
      <SiteContactsCard onDuty={onDuty} />

      {/* --------------------------------------------------- this week -- */}
      <div className="grid grid-3">
        <div className="stat">
          <div className="label">Hours this week</div>
          <div className="value">{toHours(weekMinutes)}</div>
          <div className="foot">{weekMinutes > 40 * 60 ? 'Includes overtime' : 'Straight time'}</div>
        </div>
        <div className="stat">
          <div className="label">Unread updates</div>
          <div className="value">{status.unreadBroadcasts}</div>
          <div className="foot">
            <Link to="/messages">Open updates</Link>
          </div>
        </div>
        <div className="stat" style={status.trainingDue > 0 ? { borderColor: '#f0d7ae' } : undefined}>
          <div className="label">Training due</div>
          <div className="value">{status.trainingDue}</div>
          <div className="foot">
            <Link to="/messages?tab=training">View training</Link>
          </div>
        </div>
      </div>

      {nextShift && (
        <div className="card">
          <div className="card-head">
            <h3>Next shift</h3>
            <Link className="small" to="/schedule">
              Full schedule
            </Link>
          </div>
          <div className="card-body row-between">
            <div>
              <div className="strong">{nextShift.post_name}</div>
              <div className="small muted">{nextShift.site_name}</div>
            </div>
            <div className="center">
              <div className="strong">{fmtDay(nextShift.starts_at)}</div>
              <div className="small muted">{fmtRange(nextShift.starts_at, nextShift.ends_at)}</div>
            </div>
          </div>
        </div>
      )}

      {override && (
        <OverrideDialog
          detail={override}
          onCancel={() => {
            setOverride(null);
            pendingClockIn.current = null;
          }}
          onConfirm={(reason) => clockIn(reason)}
        />
      )}
    </div>
  );
}
