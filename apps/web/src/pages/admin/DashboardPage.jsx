import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtTime, fmtDay, fmtRelative, fmtRange } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Banner, Modal, Field, useToast } from '../../components/ui.jsx';
import { formatDuration } from '@shared/domain.js';

/** Record that an officer confirmed some other way, usually when called after the reminder. */
function PhoneConfirm({ shift, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/shifts/${shift.id}/confirm`, { note: note.trim() || undefined });
      toast.success(`${shift.officer} is confirmed.`);
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Confirmed by phone"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving...' : 'Mark confirmed'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          {shift.officer}, {shift.post_name} at {shift.site_name}, {fmtDay(shift.starts_at)} {fmtRange(shift.starts_at, shift.ends_at)}.
        </div>
        <Field label="Note" hint="Optional. Kept with the shift, for supervisors only.">
          <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Spoke to them at 4pm, on the way" />
        </Field>
      </div>
    </Modal>
  );
}

/** Officers due on post in the next 12 hours who have not said they will be there. */
function UnconfirmedCard({ shifts, onChange }) {
  const [phone, setPhone] = useState(null);
  return (
    <div className={`card${shifts.some((s) => s.urgent) ? ' attention' : ''}`} id="unconfirmed">
      <div className="card-head">
        <h3>Not confirmed yet</h3>
        <span className="small muted">Starting in the next 12 hours</span>
      </div>
      <div className="list">
        {shifts.map((s) => (
          <div key={s.id} className="list-item" style={{ cursor: 'default' }}>
            <div
              className="lead-icon"
              style={s.urgent ? { background: 'var(--danger-bg)', color: 'var(--danger)' } : { background: 'var(--warn-bg)', color: 'var(--warn)' }}
            >
              <Icon name="calendar" size={17} />
            </div>
            <div className="grow">
              <div className="strong small">
                <Link to={`/admin/employees/${s.user_id}`}>{s.officer}</Link>
              </div>
              <div className="tiny muted">
                {s.post_name} &middot; {s.site_name}
              </div>
              <div className="tiny muted">
                {fmtTime(s.starts_at)} ({fmtRelative(s.starts_at)}){s.reminded ? ' · reminder sent' : ''}
              </div>
            </div>
            <div className="row wrap list-trailing" style={{ justifyContent: 'flex-end', minWidth: 0, flexShrink: 1 }}>
              {s.urgent && <Chip kind="danger">Starts soon</Chip>}
              {s.phone && (
                <a className="btn btn-ghost btn-sm" href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} aria-label={`Call ${s.officer}`}>
                  <Icon name="phone" size={14} /> Call
                </a>
              )}
              <button className="btn btn-navy btn-sm" onClick={() => setPhone(s)}>
                <Icon name="check" size={14} /> Confirmed by phone
              </button>
            </div>
          </div>
        ))}
      </div>
      {phone && (
        <PhoneConfirm
          shift={phone}
          onClose={() => setPhone(null)}
          onDone={() => {
            setPhone(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}

export default function DashboardPage() {
  const toast = useToast();
  const location = useLocation();
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/dashboard'));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { counts: {}, onDuty: [], recentFlags: [], upcoming: [], unconfirmed: [] });
    }
  }, [toast]);

  useEffect(() => {
    load();
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, [load]);

  // An alert links to a card on this page by its id.
  const loaded = Boolean(data);
  useEffect(() => {
    if (!loaded || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [loaded, location.hash]);

  if (!data) return <LoadingPage label="Loading operations" />;
  const { counts, onDuty, recentFlags, upcoming } = data;
  const unconfirmed = data.unconfirmed || [];

  return (
    <div className="page stack">
      <div className="row-between">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Live operations</div>
          <h1>Dashboard</h1>
          <p className="lead">Who is on post right now, and what needs your attention.</p>
        </div>
        <Chip kind="ok" dot>
          Live
        </Chip>
      </div>

      <div className="grid grid-4">
        <Stat label="On post now" value={counts.onDuty ?? 0} foot={`${counts.activeStaff ?? 0} active staff`} />
        <Stat
          label="Open flags"
          value={counts.openFlags ?? 0}
          foot={counts.openFlags ? 'Needs review' : 'All clear'}
          alert={counts.openFlags > 0}
        />
        <Stat label="Open incidents" value={counts.openIncidents ?? 0} foot="Submitted or under review" />
        <Stat
          label="Unfilled shifts"
          value={counts.unfilledShifts ?? 0}
          foot="Upcoming, no officer assigned"
          alert={counts.unfilledShifts > 0}
        />
      </div>

      {counts.payrollDue > 0 && (
        <Banner
          kind="warn"
          title={`Payroll: ${counts.payrollDue} pay period${counts.payrollDue === 1 ? ' has' : 's have'} ended and ${counts.payrollDue === 1 ? 'is' : 'are'} not closed`}
          action={
            <Link className="btn btn-navy btn-sm" to="/admin/payroll">
              Review payroll
            </Link>
          }
        >
          <span className="small">Approve each officer's hours and close the period so it can be paid.</span>
        </Banner>
      )}

      {/* ---------------------------------------------- field status -- */}
      <div className={`card card-pad row-between wrap${counts.lateOrOff > 0 ? ' attention' : ''}`}>
        <div className="row wrap" style={{ gap: 18 }}>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="gps" size={20} style={{ color: counts.offPost ? 'var(--danger)' : 'var(--ok)' }} />
            <div>
              <div className="strong">{counts.offPost ?? 0} off post</div>
              <div className="tiny muted">Outside their geofence right now</div>
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="clock" size={20} style={{ color: counts.lateNow ? 'var(--warn)' : 'var(--ok)' }} />
            <div>
              <div className="strong">{counts.lateNow ?? 0} not clocked in</div>
              <div className="tiny muted">Shift started, nobody on post</div>
            </div>
          </div>
        </div>
        <div className="row wrap">
          <Link className="btn btn-navy btn-sm" to="/admin/live?filter=attention">
            <Icon name="gps" size={14} /> Live tracking
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/admin/punches">
            <Icon name="list" size={14} /> Punch log
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/admin/reports">
            <Icon name="chart" size={14} /> Reports
          </Link>
        </div>
      </div>

      <div className="grid dash-split">
        {/* ------------------------------------------------- on post -- */}
        <div className="card">
          <div className="card-head">
            <h3>Officers on post</h3>
            <span className="small muted">
              {counts.hoursToday ?? 0} hours logged today
            </span>
          </div>
          {onDuty.length === 0 ? (
            <Empty icon="users" title="Nobody is clocked in">
              Officers appear here the moment they clock in.
            </Empty>
          ) : (
            <div className="list">
              {onDuty.map((o) => {
                const overdue = o.next_check_due && new Date(o.next_check_due) < new Date();
                return (
                  <Link key={o.id} className="list-item" to={`/admin/employees/${o.user_id}`}>
                    <div
                      className="lead-icon"
                      style={{ background: 'var(--ok-bg)', color: 'var(--ok)' }}
                    >
                      <Icon name="shield" size={18} />
                    </div>
                    <div className="grow">
                      <div className="strong small">{o.officer}</div>
                      <div className="tiny muted">
                        {o.post_name} &middot; {o.site_name}
                      </div>
                      <div className="tiny muted">
                        In at {fmtTime(o.clock_in_at)} &middot; {formatDuration(o.minutes_on_post)} on post
                      </div>
                    </div>
                    <div className="row wrap list-trailing" style={{ justifyContent: 'flex-end', maxWidth: 190, minWidth: 0, flexShrink: 1 }}>
                      {o.late_minutes > 0 && <Chip kind="warn">{o.late_minutes}m late</Chip>}
                      {o.clock_in_geofence === 'outside' && <Chip kind="danger">Off site</Chip>}
                      {o.missed_checks > 0 && <Chip kind="danger">{o.missed_checks} missed</Chip>}
                      {o.next_check_due && (
                        <Chip kind={overdue ? 'danger' : ''}>
                          {overdue ? 'Check overdue' : `Check ${fmtRelative(o.next_check_due)}`}
                        </Chip>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* --------------------------------------------------- flags -- */}
        <div className="card">
          <div className="card-head">
            <h3>Needs attention</h3>
            <Link className="small" to="/admin/flags">
              All flags
            </Link>
          </div>
          {recentFlags.length === 0 ? (
            <Empty icon="check" title="Nothing outstanding" />
          ) : (
            <div className="list">
              {recentFlags.slice(0, 8).map((f) => (
                <Link key={f.id} className="list-item" to="/admin/flags">
                  <div
                    className="lead-icon"
                    style={
                      f.severity === 'critical'
                        ? { background: 'var(--danger-bg)', color: 'var(--danger)' }
                        : { background: 'var(--warn-bg)', color: 'var(--warn)' }
                    }
                  >
                    <Icon name="flag" size={17} />
                  </div>
                  <div className="grow">
                    <div className="small strong">{f.label}</div>
                    <div className="tiny muted">
                      {f.officer} &middot; {fmtRelative(f.occurred_at)}
                    </div>
                  </div>
                  <StatusChip value={f.severity} />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {unconfirmed.length > 0 && <UnconfirmedCard shifts={unconfirmed} onChange={load} />}

      {/* ------------------------------------------------- next shifts -- */}
      <div className="card">
        <div className="card-head">
          <h3>Starting in the next 12 hours</h3>
          <Link className="small" to="/admin/schedule">
            Open schedule
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <Empty icon="calendar" title="No shifts starting soon" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Officer</th>
                  <th>Post</th>
                  <th>Site</th>
                  <th>Starts</th>
                  <th>Window</th>
                  <th>Confirmed</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((s) => (
                  <tr key={s.id}>
                    <td>{s.officer || <Chip kind="danger">Unfilled</Chip>}</td>
                    <td>{s.post_name}</td>
                    <td className="muted">{s.site_name}</td>
                    <td className="nowrap">
                      {fmtDay(s.starts_at)} {fmtTime(s.starts_at)}
                      <span className="muted small"> ({fmtRelative(s.starts_at)})</span>
                    </td>
                    <td className="nowrap muted">{fmtRange(s.starts_at, s.ends_at)}</td>
                    <td className="nowrap">
                      {!s.officer ? (
                        <span className="muted">--</span>
                      ) : s.confirmed ? (
                        <Chip kind="ok">{s.confirm_method === 'phone' ? 'By phone' : 'Yes'}</Chip>
                      ) : (
                        <Chip kind="warn">Not yet</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
