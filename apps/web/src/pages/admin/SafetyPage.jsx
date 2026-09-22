import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative, fmtTime } from '../../lib/format.js';
import { OpsMap, directionsLink } from '../../components/Map.jsx';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Modal, Field, Banner, Segmented, useToast,
} from '../../components/ui.jsx';
import { formatDuration } from '@shared/domain.js';

function ResolveDialog({ alert, onClose, onSaved }) {
  const toast = useToast();
  const [status, setStatus] = useState('resolved');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/panic/${alert.id}/resolve`, { status, note: note.trim() });
      toast.success('Alert closed.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Close alert - ${alert.officer}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || note.trim().length < 3}>
            Close alert
          </button>
        </>
      }
    >
      <div className="stack">
        <dl className="kv">
          <dt>Officer</dt>
          <dd>
            {alert.officer} {alert.phone && <a href={`tel:${alert.phone}`}>{alert.phone}</a>}
          </dd>
          <dt>Triggered</dt>
          <dd>{fmtDateTime(alert.triggered_at)}</dd>
          <dt>Post</dt>
          <dd>{alert.post_name || 'Not on a post'}</dd>
        </dl>

        <Field label="Outcome">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="resolved">Resolved - the officer is safe</option>
            <option value="false_alarm">False alarm</option>
          </select>
        </Field>

        <Field label="What happened?" hint="Kept on the permanent record." required>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="e.g. Reached the officer by phone within 90 seconds. Aggressive trespasser had left. Police notified, no injuries."
          />
        </Field>
      </div>
    </Modal>
  );
}

export default function SafetyPage() {
  const toast = useToast();
  const [alerts, setAlerts] = useState(null);
  const [map, setMap] = useState({ posts: [], onDuty: [], alerts: [] });
  const [scope, setScope] = useState('open');
  const [resolving, setResolving] = useState(null);

  const load = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([
        api.get(`/panic?scope=${scope === 'all' ? 'all' : 'open'}`),
        api.get('/reports/map'),
      ]);
      setAlerts(a.alerts);
      setMap(m);
    } catch (err) {
      toast.error(err.message);
      setAlerts([]);
    }
  }, [scope, toast]);

  // Duress alerts are time critical, so this polls faster than other screens.
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const acknowledge = async (alert) => {
    try {
      await api.post(`/panic/${alert.id}/acknowledge`, {});
      toast.success(`${alert.officer} has been told help is coming.`);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!alerts) return <LoadingPage label="Loading safety board" />;

  const active = alerts.filter((a) => a.status === 'active');
  const responding = alerts.filter((a) => a.status === 'acknowledged');

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Operations</div>
          <h1>Safety &amp; live map</h1>
          <p className="lead">Duress alerts, and where every officer actually is right now.</p>
        </div>
        <Chip kind="ok" dot>
          Refreshing every 15s
        </Chip>
      </div>

      {active.length > 0 && (
        <Banner kind="danger" title={`${active.length} officer${active.length === 1 ? '' : 's'} need help now`}>
          Acknowledge the alert so the officer knows someone is responding, then call them.
        </Banner>
      )}

      <div className="grid grid-4">
        <Stat label="Active alerts" value={active.length} foot="Unacknowledged" alert={active.length > 0} />
        <Stat label="Responding" value={responding.length} foot="Supervisor en route" />
        <Stat label="Officers on post" value={map.onDuty?.length || 0} foot="Right now" />
        <Stat label="Mapped posts" value={map.posts?.length || 0} foot="With a geofence" />
      </div>

      {/* ----------------------------------------------------- alerts -- */}
      {(active.length > 0 || responding.length > 0) && (
        <div className="card" style={{ borderColor: '#f3c9c3' }}>
          <div className="card-head">
            <h3>Open duress alerts</h3>
          </div>
          <div className="list">
            {[...active, ...responding].map((a) => (
              <div key={a.id} className="list-item" style={{ cursor: 'default' }}>
                <div
                  className="lead-icon"
                  style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}
                >
                  <Icon name="alert" size={19} />
                </div>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 7 }}>
                    <Link to={`/admin/employees/${a.user_id}`} className="strong">
                      {a.officer}
                    </Link>
                    <StatusChip value={a.status} />
                    <span className="tiny muted mono">{a.employee_code}</span>
                  </div>
                  <div className="small">
                    {a.post_name ? `${a.post_name} - ${a.site_name}` : 'Not clocked in to a post'}
                  </div>
                  <div className="tiny muted">
                    Triggered {fmtTime(a.triggered_at)} ({fmtRelative(a.triggered_at)})
                    {a.acknowledged_by_name && ` - acknowledged by ${a.acknowledged_by_name}`}
                  </div>
                </div>
                <div className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  {a.phone && (
                    <a className="btn btn-sm btn-navy" href={`tel:${a.phone}`}>
                      Call
                    </a>
                  )}
                  {a.latitude != null && (
                    <a
                      className="btn btn-sm btn-ghost"
                      href={directionsLink(a.latitude, a.longitude)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="pin" size={14} /> Directions
                    </a>
                  )}
                  {a.status === 'active' && (
                    <button className="btn btn-sm btn-danger" onClick={() => acknowledge(a)}>
                      Acknowledge
                    </button>
                  )}
                  <button className="btn btn-sm btn-primary" onClick={() => setResolving(a)}>
                    Close
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------- map -- */}
      <div className="card">
        <div className="card-head">
          <h3>Live map</h3>
          <span className="small muted">
            Green pins are staffed posts, grey are unstaffed, navy is where an officer clocked in
          </span>
        </div>
        <div style={{ padding: 12 }}>
          <OpsMap posts={map.posts} onDuty={map.onDuty} alerts={map.alerts} height={480} />
        </div>
      </div>

      {/* --------------------------------------------------- on post -- */}
      <div className="card">
        <div className="card-head">
          <h3>On post now</h3>
        </div>
        {(map.onDuty || []).length === 0 ? (
          <Empty icon="users" title="Nobody is clocked in" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Officer</th>
                  <th>Post</th>
                  <th>On post</th>
                  <th>Location check</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {map.onDuty.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/admin/employees/${o.user_id}`} className="strong">
                        {o.officer}
                      </Link>
                      {o.phone && <div className="tiny muted">{o.phone}</div>}
                    </td>
                    <td className="small">
                      {o.post_name}
                      <div className="tiny muted">{o.site_name}</div>
                    </td>
                    <td className="small nowrap">
                      {formatDuration(o.minutes_on_post)}
                      <div className="tiny muted">since {fmtTime(o.clock_in_at)}</div>
                    </td>
                    <td>
                      <StatusChip value={o.clock_in_geofence} />
                      {o.clock_in_distance_m != null && o.clock_in_geofence === 'outside' && (
                        <div className="tiny muted">{o.clock_in_distance_m}m away</div>
                      )}
                    </td>
                    <td>
                      {o.clock_in_lat != null && (
                        <a
                          className="btn btn-sm btn-ghost"
                          href={directionsLink(o.clock_in_lat, o.clock_in_lng)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Map
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ------------------------------------------------- alert log -- */}
      <div className="row-between">
        <h3>Alert history</h3>
        <Segmented
          label="Safety view"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'open', label: 'Open only' },
            { value: 'all', label: 'All alerts' },
          ]}
        />
      </div>

      <div className="card">
        {alerts.length === 0 ? (
          <Empty icon="shield" title="No duress alerts">
            Officers trigger these from the mobile app when they need help.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Triggered</th>
                  <th>Officer</th>
                  <th>Post</th>
                  <th>Status</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap small">{fmtDateTime(a.triggered_at)}</td>
                    <td className="small">{a.officer}</td>
                    <td className="small muted">{a.post_name || '--'}</td>
                    <td>
                      <StatusChip value={a.status} />
                    </td>
                    <td className="tiny muted">{a.resolution_note || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {resolving && (
        <ResolveDialog
          alert={resolving}
          onClose={() => setResolving(null)}
          onSaved={() => {
            setResolving(null);
            load();
          }}
        />
      )}
    </div>
  );
}
