import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime, fmtTime } from '../../lib/format.js';
import { LoadingPage, Icon, Chip, StatusChip, Empty, useToast, Banner } from '../../components/ui.jsx';
import { ROLE_LABEL, FLAG_LABEL, toHours } from '@shared/domain.js';

export default function ProfilePage() {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [hours, setHours] = useState(null);
  const [flags, setFlags] = useState([]);
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [h, f, e] = await Promise.all([
          api.get('/schedule/hours'),
          api.get('/schedule/my-flags'),
          api.get('/timeclock/entries?limit=12'),
        ]);
        setHours(h);
        setFlags(f.flags);
        setEntries(e.entries);
      } catch (err) {
        toast.error(err.message);
      }
    })();
  }, [toast]);

  if (!hours) return <LoadingPage label="Loading your record" />;

  const licenseExpiring =
    user.license_expires_on &&
    new Date(user.license_expires_on) < new Date(Date.now() + 60 * 86400000);

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">My record</div>
        <h1>{user.full_name}</h1>
        <p className="lead">
          {ROLE_LABEL[user.role]} &middot; Employee code {user.employee_code}
        </p>
      </div>

      {licenseExpiring && (
        <Banner kind="warn" title="Licence renewal due">
          Your {user.license_type || 'security'} licence expires {fmtDate(user.license_expires_on)}. Speak to
          the office about renewal before it lapses.
        </Banner>
      )}

      <div className="grid grid-4">
        <div className="stat">
          <div className="label">This week</div>
          <div className="value">{hours.thisWeek.hours}</div>
          <div className="foot">{hours.thisWeek.shifts} shifts</div>
        </div>
        <div className="stat">
          <div className="label">Overtime</div>
          <div className="value">{hours.thisWeek.overtimeHours}</div>
          <div className="foot">Hours past 40</div>
        </div>
        <div className="stat">
          <div className="label">Last week</div>
          <div className="value">{hours.lastWeek.hours}</div>
          <div className="foot">{hours.lastWeek.shifts} shifts</div>
        </div>
        <div className="stat" style={hours.openFlags ? { borderColor: '#f0d7ae' } : undefined}>
          <div className="label">Open flags</div>
          <div className="value">{hours.openFlags}</div>
          <div className="foot">{hours.openFlags ? 'Under review' : 'All clear'}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Employment details</h3>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>Role</dt>
              <dd>{ROLE_LABEL[user.role]}</dd>
              <dt>Status</dt>
              <dd>
                <StatusChip value={user.status} />
              </dd>
              {user.hire_date && (
                <>
                  <dt>Hired</dt>
                  <dd>{fmtDate(user.hire_date)}</dd>
                </>
              )}
              {user.license_number && (
                <>
                  <dt>Licence</dt>
                  <dd>
                    {user.license_type} {user.license_number}
                    {user.license_expires_on && (
                      <span className="muted"> - expires {fmtDate(user.license_expires_on)}</span>
                    )}
                  </dd>
                </>
              )}
              {user.phone && (
                <>
                  <dt>Phone</dt>
                  <dd>{user.phone}</dd>
                </>
              )}
              {user.email && (
                <>
                  <dt>Email</dt>
                  <dd className="truncate">{user.email}</dd>
                </>
              )}
              {user.emergency_contact_name && (
                <>
                  <dt>Emergency contact</dt>
                  <dd>
                    {user.emergency_contact_name}
                    {user.emergency_contact_phone ? ` - ${user.emergency_contact_phone}` : ''}
                  </dd>
                </>
              )}
              <dt>Last sign-in</dt>
              <dd>{user.last_login_at ? fmtDateTime(user.last_login_at) : 'This is your first'}</dd>
            </dl>
          </div>
          <div className="card-foot row" style={{ gap: 10 }}>
            <Link className="btn btn-ghost btn-sm" to="/change-pin">
              <Icon name="shield" size={15} /> Change PIN
            </Link>
            <button className="btn btn-danger btn-sm" onClick={signOut}>
              <Icon name="logout" size={15} /> Sign out
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Attendance notes</h3>
            <span className="small muted">{flags.length}</span>
          </div>
          {flags.length === 0 ? (
            <Empty icon="check" title="Nothing on record">
              No late arrivals or missed check-ins. Keep it up.
            </Empty>
          ) : (
            <div className="list">
              {flags.slice(0, 8).map((f) => (
                <div key={f.id} className="list-item" style={{ cursor: 'default' }}>
                  <div
                    className="lead-icon"
                    style={
                      f.resolved_at
                        ? { background: 'var(--ok-bg)', color: 'var(--ok)' }
                        : { background: 'var(--warn-bg)', color: 'var(--warn)' }
                    }
                  >
                    <Icon name={f.resolved_at ? 'check' : 'flag'} size={17} />
                  </div>
                  <div className="grow">
                    <div className="small strong">{FLAG_LABEL[f.type] || f.type}</div>
                    <div className="tiny muted">{fmtDateTime(f.occurred_at)}</div>
                    {f.resolution_note && <div className="tiny muted">Resolved: {f.resolution_note}</div>}
                  </div>
                  {f.resolved_at ? <Chip kind="ok">Closed</Chip> : <StatusChip value={f.severity} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Recent clock history</h3>
          <Link className="small" to="/schedule">
            Full schedule
          </Link>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Post</th>
                <th>In</th>
                <th>Out</th>
                <th className="num">Hours</th>
                <th>Location</th>
                <th>Check-ins</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{fmtDate(e.clock_in_at)}</td>
                  <td>
                    <div className="strong small">{e.post_name}</div>
                    <div className="tiny muted">{e.site_name}</div>
                  </td>
                  <td className="nowrap">
                    {fmtTime(e.clock_in_at)}
                    {e.late_minutes > 0 && <Chip kind="warn">+{e.late_minutes}m</Chip>}
                  </td>
                  <td className="nowrap">{e.clock_out_at ? fmtTime(e.clock_out_at) : <Chip kind="brand">On post</Chip>}</td>
                  <td className="num">{e.minutes_worked != null ? toHours(e.minutes_worked) : '--'}</td>
                  <td>
                    <StatusChip value={e.clock_in_geofence} />
                  </td>
                  <td>
                    {e.checks.missed > 0 ? (
                      <Chip kind="danger">{e.checks.missed} missed</Chip>
                    ) : (
                      <Chip kind="ok">{e.checks.answered || 0} ok</Chip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
