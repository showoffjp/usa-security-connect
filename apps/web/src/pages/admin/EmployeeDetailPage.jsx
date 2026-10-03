import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime, fmtTime, fmtDay, fmtRange, fmtMoney } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Modal, Field, useToast, Segmented,
} from '../../components/ui.jsx';
import { CredentialsDialog } from './EmployeesPage.jsx';
import PtoCard from './PtoCard.jsx';
import { ROLE_LABEL, toHours } from '@shared/domain.js';

/** Correcting a punch always records who changed it and why. */
function AdjustDialog({ entry, onClose, onSaved }) {
  const toast = useToast();
  const toLocal = (d) => (d ? new Date(d).toISOString().slice(0, 16) : '');
  const [form, setForm] = useState({
    clockInAt: toLocal(entry.clock_in_at),
    clockOutAt: toLocal(entry.clock_out_at),
    reason: '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/admin/time-entries/${entry.id}`, {
        clockInAt: new Date(form.clockInAt).toISOString(),
        clockOutAt: form.clockOutAt ? new Date(form.clockOutAt).toISOString() : null,
        reason: form.reason.trim(),
      });
      toast.success('Time entry corrected.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Correct time entry"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.reason.trim().length < 5}>
            Save correction
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Clock in">
            <input
              type="datetime-local"
              value={form.clockInAt}
              onChange={(e) => setForm((f) => ({ ...f, clockInAt: e.target.value }))}
            />
          </Field>
          <Field label="Clock out" hint="Leave blank to reopen the shift.">
            <input
              type="datetime-local"
              value={form.clockOutAt}
              onChange={(e) => setForm((f) => ({ ...f, clockOutAt: e.target.value }))}
            />
          </Field>
        </div>
        <Field label="Reason for the correction" hint="Kept on the record permanently." required>
          <textarea
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            placeholder="e.g. Officer's phone lost signal; clock-out time confirmed by the site log."
          />
        </Field>
      </div>
    </Modal>
  );
}

export default function EmployeeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('time');
  const [adjust, setAdjust] = useState(null);
  const [credentials, setCredentials] = useState(null);

  const load = async () => {
    try {
      setData(await api.get(`/admin/employees/${id}`));
    } catch (err) {
      toast.error(err.message);
      navigate('/admin/employees', { replace: true });
    }
  };
  useEffect(() => {
    load();
  }, [id]);

  const resetPin = async () => {
    try {
      setCredentials(await api.post(`/admin/employees/${id}/reset-pin`, {}));
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!data) return <LoadingPage label="Loading employee" />;
  const { employee: e, entries, flags, shifts, last30Days } = data;

  return (
    <div className="page stack">
      <div className="row">
        <Link className="btn btn-ghost btn-sm" to="/admin/employees">
          <Icon name="back" size={16} /> Employees
        </Link>
      </div>

      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">
            {ROLE_LABEL[e.role]} &middot; Code {e.employee_code}
          </div>
          <h1>{e.full_name}</h1>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <StatusChip value={e.status} />
            {e.locked && <Chip kind="danger">Locked out</Chip>}
            {Boolean(e.must_change_pin) && <Chip kind="warn">Must change PIN</Chip>}
            {e.license_number && (
              <Chip kind="navy">
                {e.license_type} {e.license_number}
              </Chip>
            )}
          </div>
        </div>
        <div className="row wrap">
          <Link className="btn btn-ghost btn-sm" to={`/admin/live?filter=all&track=${e.id}`}>
            <Icon name="gps" size={15} /> GPS track
          </Link>
          <Link className="btn btn-ghost btn-sm" to={`/admin/punches?userId=${e.id}`}>
            <Icon name="list" size={15} /> Punches
          </Link>
          <Link className="btn btn-ghost btn-sm" to={`/admin/reports?report=officer-site&userId=${e.id}`}>
            <Icon name="chart" size={15} /> Hours by site
          </Link>
          {isAdmin && (
            <button className="btn btn-ghost btn-sm" onClick={resetPin}>
              <Icon name="shield" size={15} /> Reset PIN
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Hours (30 days)" value={last30Days.hours} foot={`${last30Days.shifts} shifts`} />
        <Stat label="Late arrivals" value={last30Days.lateCount} foot="Last 30 days" alert={last30Days.lateCount > 2} />
        <Stat
          label="Open flags"
          value={flags.filter((f) => !f.resolved_at).length}
          foot="Awaiting review"
          alert={flags.some((f) => !f.resolved_at)}
        />
        <Stat
          label="Pay rate"
          value={e.pay_rate_cents ? fmtMoney(e.pay_rate_cents) : '--'}
          foot="Per hour"
        />
      </div>

      <PtoCard userId={e.id} name={e.full_name} isAdmin={isAdmin} />

      <div className="grid side-split">
        <div className="card">
          <div className="card-head">
            <h3>Details</h3>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>Phone</dt>
              <dd>{e.phone || '--'}</dd>
              <dt>Email</dt>
              <dd className="truncate">{e.email || '--'}</dd>
              <dt>Home site</dt>
              <dd>{e.default_site_name || '--'}</dd>
              <dt>Hired</dt>
              <dd>{e.hire_date ? fmtDate(e.hire_date) : '--'}</dd>
              <dt>Licence expires</dt>
              <dd>{e.license_expires_on ? fmtDate(e.license_expires_on) : '--'}</dd>
              <dt>Emergency</dt>
              <dd>
                {e.emergency_contact_name || '--'}
                {e.emergency_contact_phone ? ` (${e.emergency_contact_phone})` : ''}
              </dd>
              <dt>PIN set</dt>
              <dd>{e.pin_set_at ? fmtDate(e.pin_set_at) : '--'}</dd>
              <dt>Last sign-in</dt>
              <dd>{e.last_login_at ? fmtDateTime(e.last_login_at) : 'Never'}</dd>
            </dl>
            {e.notes && (
              <>
                <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '14px 0' }} />
                <div className="small muted" style={{ whiteSpace: 'pre-line' }}>
                  {e.notes}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <Segmented
          label="Employee record section"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'time', label: 'Time entries' },
                { value: 'flags', label: `Flags (${flags.length})` },
                { value: 'shifts', label: 'Upcoming' },
              ]}
            />
          </div>

          {tab === 'time' && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Post</th>
                    <th>In</th>
                    <th>Out</th>
                    <th className="num">Hrs</th>
                    <th>Location</th>
                    {isAdmin && <th />}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((t) => (
                    <tr key={t.id}>
                      <td className="nowrap small">{fmtDate(t.clock_in_at)}</td>
                      <td className="small">
                        {t.post_name}
                        <div className="tiny muted">{t.site_name}</div>
                      </td>
                      <td className="nowrap small">
                        {fmtTime(t.clock_in_at)}
                        {t.late_minutes > 0 && <Chip kind="warn">+{t.late_minutes}m</Chip>}
                      </td>
                      <td className="nowrap small">
                        {t.clock_out_at ? fmtTime(t.clock_out_at) : <Chip kind="brand">On post</Chip>}
                        {Boolean(t.auto_closed) && <Chip kind="danger">Auto</Chip>}
                      </td>
                      <td className="num">{t.minutes_worked != null ? toHours(t.minutes_worked) : '--'}</td>
                      <td>
                        <StatusChip value={t.clock_in_geofence} />
                        {t.clock_in_distance_m != null && t.clock_in_geofence === 'outside' && (
                          <div className="tiny muted">{t.clock_in_distance_m}m away</div>
                        )}
                      </td>
                      {isAdmin && (
                        <td>
                          <button className="btn btn-sm btn-ghost" onClick={() => setAdjust(t)}>
                            Correct
                          </button>
                          {t.adjustment_reason && (
                            <div className="tiny muted truncate" style={{ maxWidth: 160 }} title={t.adjustment_reason}>
                              {t.adjustment_reason}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'flags' &&
            (flags.length === 0 ? (
              <Empty icon="check" title="No flags on record" />
            ) : (
              <div className="list">
                {flags.map((f) => (
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
                      <div className="small strong">{f.label}</div>
                      <div className="tiny muted">{fmtDateTime(f.occurred_at)}</div>
                      {f.resolution_note && <div className="tiny muted">Resolved: {f.resolution_note}</div>}
                    </div>
                    {f.resolved_at ? <Chip kind="ok">Closed</Chip> : <StatusChip value={f.severity} />}
                  </div>
                ))}
              </div>
            ))}

          {tab === 'shifts' &&
            (shifts.length === 0 ? (
              <Empty icon="calendar" title="No upcoming shifts" />
            ) : (
              <div className="list">
                {shifts.map((s) => (
                  <div key={s.id} className="list-item" style={{ cursor: 'default' }}>
                    <div className="lead-icon">
                      <Icon name="calendar" size={17} />
                    </div>
                    <div className="grow">
                      <div className="small strong">{s.post_name}</div>
                      <div className="tiny muted">{s.site_name}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="small nowrap">{fmtDay(s.starts_at)}</div>
                      <div className="tiny muted nowrap">{fmtRange(s.starts_at, s.ends_at)}</div>
                    </div>
                    <StatusChip value={s.status} />
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>

      {adjust && (
        <AdjustDialog
          entry={adjust}
          onClose={() => setAdjust(null)}
          onSaved={() => {
            setAdjust(null);
            load();
          }}
        />
      )}
      {credentials && <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />}
    </div>
  );
}
