import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateShort, fmtDateTime, fmtTime, fmtMoney } from '../../lib/format.js';
import { LoadingPage, Icon, Chip, StatusChip, Empty, useToast, Banner } from '../../components/ui.jsx';
import { ROLE_LABEL, FLAG_LABEL, toHours } from '@shared/domain.js';
import MyExpenses from './MyExpenses.jsx';
import MyTimeOff from './MyTimeOff.jsx';
import { MySiteTraining } from './SiteTraining.jsx';
import { MyCommendations } from './Commendations.jsx';

export default function ProfilePage() {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [hours, setHours] = useState(null);
  const [flags, setFlags] = useState([]);
  const [entries, setEntries] = useState([]);
  const [pay, setPay] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [h, f, e, p] = await Promise.all([
          api.get('/schedule/hours'),
          api.get('/schedule/my-flags'),
          api.get('/timeclock/entries?limit=12'),
          api.get('/schedule/my-pay'),
        ]);
        setHours(h);
        setFlags(f.flags);
        setEntries(e.entries);
        setPay(p);
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

      {pay && <MyPay pay={pay} />}

      <MyCommendations />

      <MySiteTraining />

      <MyTimeOff />

      <MyExpenses />

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

const money = (dollars) => (dollars == null ? '--' : fmtMoney(Math.round(dollars * 100)));

/** What this person has been paid, period by period, and is earning this week. */
function MyPay({ pay }) {
  const { basis, thisWeek, stubs } = pay;
  const contractor = basis.employment_type === '1099';
  const rateText =
    basis.pay_type === 'salary'
      ? `Salaried${basis.salary != null ? `, ${money(basis.salary)} per period` : ''}`
      : basis.pay_type === 'per_shift'
        ? `${money(basis.pay_rate)} per shift`
        : `${money(basis.pay_rate)} an hour${basis.earns_overtime ? `, ${basis.overtime_multiplier || 1.5}x past 40 hours a week` : ''}`;

  return (
    <div className="card">
      <div className="card-head wrap">
        <h3>{contractor ? 'My payments' : 'My pay'}</h3>
        <span className="small muted">
          {contractor ? '1099 contractor' : 'W-2 employee'} · {rateText}
        </span>
      </div>
      <div className="card-body stack">
        <div className="grid grid-3">
          <div className="stat">
            <div className="label">This week so far</div>
            <div className="value">{money(thisWeek.estimated_pay)}</div>
            <div className="foot">
              {thisWeek.hours}h over {thisWeek.shifts} shift{thisWeek.shifts === 1 ? '' : 's'} · estimate
              {thisWeek.holiday_hours > 0 && ` · ${thisWeek.holiday_hours}h on a holiday`}
            </div>
          </div>
          <div className="stat">
            <div className="label">Overtime this week</div>
            <div className="value">{basis.earns_overtime ? `${thisWeek.overtime_hours}h` : '--'}</div>
            <div className="foot">{basis.earns_overtime ? 'Hours past 40' : 'Not paid overtime'}</div>
          </div>
          <div className="stat">
            <div className="label">Last pay period</div>
            <div className="value">{stubs[0] ? money(stubs[0].gross_pay) : '--'}</div>
            <div className="foot">
              {stubs[0] ? `${fmtDateShort(stubs[0].period_start)} to ${fmtDateShort(stubs[0].period_end)}` : 'None closed yet'}
            </div>
          </div>
        </div>
        <p className="tiny muted" style={{ margin: 0 }}>
          This week is worked out from your punches so far and may change until payroll is approved. Closed periods
          below are exactly what was approved for payment{contractor ? '' : ', before taxes and deductions'}.
        </p>
      </div>
      {stubs.length === 0 ? (
        <Empty icon="dollar" title="No closed pay periods yet">
          Your pay for each period appears here once payroll closes it.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="sr-only">{contractor ? 'Payments' : 'Pay'} by pay period</caption>
            <thead>
              <tr>
                <th>Pay period</th>
                <th className="num">Hours</th>
                <th className="num">Regular</th>
                <th className="num">Overtime & holiday</th>
                <th className="num">Gross</th>
                <th className="num">Time off</th>
                <th className="num">Expenses</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {stubs.map((s) => (
                <tr key={s.period_id}>
                  <td className="nowrap">
                    {fmtDateShort(s.period_start)} to {fmtDate(s.period_end)}
                    <div className="tiny muted">{s.shifts} shift{s.shifts === 1 ? '' : 's'}</div>
                  </td>
                  <td className="num">{s.hours}h</td>
                  <td className="num small">{money(s.regular_pay)}</td>
                  <td className="num small">
                    {s.overtime_hours > 0 && (
                      <>
                        {money(s.overtime_pay)}
                        <div className="tiny muted">{s.overtime_hours}h overtime</div>
                      </>
                    )}
                    {s.holiday_hours > 0 && (
                      <>
                        {s.holiday_pay ? money(s.holiday_pay) : ''}
                        <div className="tiny muted">{s.holiday_hours}h holiday</div>
                      </>
                    )}
                    {!s.overtime_hours && !s.holiday_hours && '--'}
                  </td>
                  <td className="num strong">{money(s.gross_pay)}</td>
                  <td className="num small">
                {s.pto_pay ? money(s.pto_pay) : '--'}
                {s.pto_hours ? <div className="tiny muted">{s.pto_hours} h paid</div> : null}
                {s.pto_earned ? <div className="tiny muted">+{s.pto_earned} h earned</div> : null}
              </td>
              <td className="num small">{s.reimbursements ? money(s.reimbursements) : '--'}</td>
                  <td className="small">
                    {s.sites.map((x) => (
                      <div key={x.site}>
                        {x.site} <span className="tiny muted">{x.hours}h</span>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
