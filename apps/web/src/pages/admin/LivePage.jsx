import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtTime, fmtRange, fmtDay, fmtRelative, toDateInput } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Modal, Banner, useToast } from '../../components/ui.jsx';
import { LiveMap, TrackMap, LIVE_PIN, directionsLink } from '../../components/Map.jsx';
import { formatDuration, formatDistance, LIVE_STATUS_LABEL, EMPLOYMENT_LABEL } from '@shared/domain.js';

const NEEDS_ATTENTION = ['duress', 'off_post', 'no_show', 'late'];

const FILTERS = [
  { value: 'attention', label: 'Needs attention', match: (o) => NEEDS_ATTENTION.includes(o.status) || o.gps_stale },
  { value: 'on_duty', label: 'On duty', match: (o) => Boolean(o.entry) },
  { value: 'upcoming', label: 'Starting soon', match: (o) => o.status === 'upcoming' },
  { value: 'all_scheduled', label: 'Everyone with a shift', match: (o) => Boolean(o.job) },
  { value: 'all', label: 'Everyone', match: () => true },
];

/* ------------------------------------------------------------ track -- */

function TrackDialog({ officer, onClose }) {
  const toast = useToast();
  const [date, setDate] = useState(toDateInput(new Date()));
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api
      .get(`/admin/live/track/${officer.user_id}?date=${date}`)
      .then((d) => alive && setData(d))
      .catch((err) => {
        toast.error(err.message);
        if (alive) setData({ pings: [], entries: [], summary: {} });
      });
    return () => {
      alive = false;
    };
  }, [officer.user_id, date, toast]);

  return (
    <Modal title={`GPS track - ${officer.name || data?.officer?.name || ''}`} onClose={onClose} wide>
      <div className="stack">
        <div className="row wrap">
          <label className="small strong" htmlFor="track-date">
            Day
          </label>
          <input
            id="track-date"
            type="date"
            value={date}
            max={toDateInput(new Date())}
            onChange={(e) => setDate(e.target.value)}
            style={{ width: 'auto' }}
          />
          <span className="spacer" />
          <Link className="btn btn-ghost btn-sm" to={`/admin/employees/${officer.user_id}`}>
            <Icon name="user" size={14} /> Profile
          </Link>
          <Link className="btn btn-ghost btn-sm" to={`/admin/punches?userId=${officer.user_id}`}>
            <Icon name="list" size={14} /> Punches
          </Link>
        </div>

        {!data ? (
          <LoadingPage label="Loading the track" />
        ) : data.pings.length === 0 && data.entries.length === 0 ? (
          <Empty icon="gps" title="Nothing recorded that day">
            Position is only recorded while an officer is clocked in.
          </Empty>
        ) : (
          <>
            <div className="grid grid-4">
              <Stat label="Time inside fence" value={data.summary.inside_percent != null ? `${data.summary.inside_percent}%` : '--'} />
              <Stat
                label="Walk-offs"
                value={data.summary.off_post_events ?? 0}
                alert={data.summary.off_post_events > 0}
                foot={`Furthest ${formatDistance(data.summary.max_distance_m)}`}
              />
              <Stat label="Distance covered" value={formatDistance(data.summary.distance_walked_m)} foot={`${data.summary.pings} GPS points`} />
              <Stat label="Worked" value={formatDuration(data.summary.minutes_worked)} foot={`${data.entries.length} shift(s)`} />
            </div>

            <TrackMap pings={data.pings} entries={data.entries} />

            <div className="table-wrap">
              <table className="data">
                <caption className="sr-only">Shifts worked that day</caption>
                <thead>
                  <tr>
                    <th>Post</th>
                    <th>Clock in</th>
                    <th>Clock out</th>
                    <th>At clock-in</th>
                    <th className="num">Worked</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div className="strong small">{e.post_name}</div>
                        <div className="tiny muted">{e.site_name}</div>
                      </td>
                      <td className="nowrap">
                        {fmtTime(e.clock_in_at)}
                        {e.late_minutes > 0 && <Chip kind="warn">{e.late_minutes}m late</Chip>}
                      </td>
                      <td className="nowrap">{e.clock_out_at ? fmtTime(e.clock_out_at) : <Chip kind="brand" dot>On post</Chip>}</td>
                      <td>
                        <StatusChip value={e.clock_in_geofence} />
                      </td>
                      <td className="num">{e.minutes_worked != null ? formatDuration(e.minutes_worked) : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <details>
              <summary className="small strong" style={{ cursor: 'pointer' }}>
                Every GPS reading ({data.pings.length})
              </summary>
              <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto', marginTop: 8 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Source</th>
                      <th>Fence</th>
                      <th className="num">From post</th>
                      <th className="num">Accuracy</th>
                      <th>Map</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pings.map((p) => (
                      <tr key={p.id}>
                        <td className="nowrap">{fmtTime(p.recorded_at)}</td>
                        <td className="small">{String(p.source).replace('_', ' ')}</td>
                        <td>
                          <StatusChip value={p.geofence} />
                        </td>
                        <td className="num">{formatDistance(p.distance_m)}</td>
                        <td className="num">{p.accuracy != null ? `±${Math.round(p.accuracy)} m` : '--'}</td>
                        <td>
                          <a
                            className="small"
                            href={`https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- page -- */

function LocationCell({ o, staleAfter }) {
  if (!o.entry) return <span className="muted small">Not on the clock</span>;
  const loc = o.location;
  if (!loc) return <Chip kind="warn">No GPS yet</Chip>;
  const outside = loc.geofence === 'outside';
  return (
    <div className="stack-sm" style={{ gap: 2 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="strong small" style={{ color: outside ? 'var(--danger)' : undefined }}>
          {formatDistance(loc.distance_m)} from post
        </span>
        <StatusChip value={loc.geofence} />
      </div>
      <div className="tiny muted">
        {loc.minutes_ago != null ? `Seen ${loc.minutes_ago <= 0 ? 'just now' : `${loc.minutes_ago} min ago`}` : ''}
        {loc.accuracy ? ` · ±${Math.round(loc.accuracy)} m` : ''}
        {o.gps_stale && (
          <>
            {' '}
            · <span style={{ color: 'var(--warn)', fontWeight: 650 }}>no signal for over {staleAfter} min</span>
          </>
        )}
      </div>
    </div>
  );
}

export default function LivePage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState(params.get('filter') || 'on_duty');
  const [site, setSite] = useState('');
  const [query, setQuery] = useState('');
  const [auto, setAuto] = useState(true);
  const [focusId, setFocusId] = useState(null);
  const [tracking, setTracking] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/admin/live');
      setData(d);
      setLoadedAt(new Date());
    } catch (err) {
      toast.error(err.message);
      setData((prev) => prev || { counts: {}, officers: [], posts: [], uncovered: [], rules: {} });
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [auto, load]);

  // A deep link from an employee's profile opens their track straight away.
  useEffect(() => {
    const id = Number(params.get('track'));
    if (!id || !data) return;
    setTracking(data.officers.find((o) => o.user_id === id) || { user_id: id, name: '' });
    params.delete('track');
    setParams(params, { replace: true });
  }, [data, params, setParams]);

  const sites = useMemo(() => {
    const map = new Map();
    (data?.posts || []).forEach((p) => map.set(p.site_id, p.site_name));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const visible = useMemo(() => {
    if (!data) return [];
    const f = FILTERS.find((x) => x.value === filter) || FILTERS[0];
    const q = query.trim().toLowerCase();
    return data.officers.filter(
      (o) =>
        f.match(o) &&
        (!site || String(o.job?.site_id) === site) &&
        (!q ||
          o.name.toLowerCase().includes(q) ||
          o.employee_code.includes(q) ||
          (o.job?.post_name || '').toLowerCase().includes(q) ||
          (o.job?.site_name || '').toLowerCase().includes(q))
    );
  }, [data, filter, site, query]);

  const mapPosts = useMemo(
    () => (data?.posts || []).filter((p) => !site || String(p.site_id) === site),
    [data, site]
  );

  if (!data) return <LoadingPage label="Locating officers" />;
  const c = data.counts;

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Operations</div>
          <h1>Live tracking</h1>
          <p className="lead">
            Where every officer actually is, against where they are scheduled to be.
          </p>
        </div>
        <div className="row wrap">
          <span className="small muted" aria-live="polite">
            {loadedAt ? `Updated ${fmtTime(loadedAt)}` : ''}
          </span>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} style={{ width: 'auto' }} />
            Auto-refresh
          </label>
          <button className="btn btn-ghost btn-sm" onClick={load}>
            <Icon name="refresh" size={15} /> Refresh
          </button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Stat label="On duty" value={c.on_duty ?? 0} foot={`${c.on_post ?? 0} on post, ${c.on_break ?? 0} on break`} />
        <Stat label="Off post" value={c.off_post ?? 0} alert={c.off_post > 0} foot="Outside their geofence" />
        <Stat label="Late / no-show" value={(c.late ?? 0) + (c.no_show ?? 0)} alert={c.late + c.no_show > 0} foot={`${c.late ?? 0} late, ${c.no_show ?? 0} no-show`} />
        <Stat label="GPS gone quiet" value={c.gps_stale ?? 0} alert={c.gps_stale > 0} foot={`No position for ${data.rules.gpsStaleMinutes} min`} />
        <Stat label="Starting soon" value={c.upcoming ?? 0} foot="Within 12 hours" />
        <Stat label="Uncovered posts" value={c.uncovered ?? 0} alert={c.uncovered > 0} foot="Running, nobody assigned" />
      </div>

      {data.counts.duress > 0 && (
        <Banner kind="danger" title="Duress alert active" action={<Link className="btn btn-danger btn-sm" to="/admin/safety">Open safety board</Link>}>
          An officer has pressed the duress button. Respond from the safety board.
        </Banner>
      )}

      {data.uncovered.length > 0 && (
        <Banner kind="warn" title={`${data.uncovered.length} post(s) running with nobody assigned`} action={<Link className="btn btn-ghost btn-sm" to="/admin/schedule">Open schedule</Link>}>
          {data.uncovered.map((u) => `${u.post_name} at ${u.site_name} (${fmtRange(u.starts_at, u.ends_at)})`).join('; ')}
        </Banner>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Map</h3>
          <div className="row wrap small" style={{ gap: 12 }} aria-label="Map legend">
            {['on_post', 'off_post', 'on_break', 'duress'].map((s) => (
              <span key={s} className="row" style={{ gap: 5 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 16, height: 16, borderRadius: '50%', background: LIVE_PIN[s][0], color: '#fff',
                    fontSize: 10, fontWeight: 700, display: 'grid', placeItems: 'center',
                  }}
                >
                  {LIVE_PIN[s][1]}
                </span>
                {LIVE_STATUS_LABEL[s]}
              </span>
            ))}
            <span className="row" style={{ gap: 5 }}>
              <span aria-hidden="true" style={{ width: 18, borderTop: '2px dashed #B3261E' }} /> Way back to post
            </span>
          </div>
        </div>
        <div className="card-body">
          <LiveMap officers={visible} posts={mapPosts} focusId={focusId} onSelect={(o) => setFocusId(o.user_id)} />
        </div>
      </div>

      <div className="card">
        <div className="card-head wrap">
          <div className="seg" role="radiogroup" aria-label="Show">
            {FILTERS.map((f) => {
              const n = data.officers.filter(f.match).length;
              return (
                <button
                  key={f.value}
                  type="button"
                  role="radio"
                  aria-checked={filter === f.value}
                  className={filter === f.value ? 'active' : ''}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label} ({n})
                </button>
              );
            })}
          </div>
          <div className="row wrap">
            <select aria-label="Filter by site" value={site} onChange={(e) => setSite(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All sites</option>
              {sites.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label="Search officers, posts or sites"
              placeholder="Search name, code, post"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 200 }}
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <Empty icon="users" title="Nobody matches">
            Try another filter.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Officers with their status, assignment and location</caption>
              <thead>
                <tr>
                  <th>Officer</th>
                  <th>Status</th>
                  <th>Assigned post &amp; address</th>
                  <th>Shift &amp; clock-in</th>
                  <th>Actual location</th>
                  <th className="num">Hours today / wk</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => (
                  <tr key={o.user_id} style={focusId === o.user_id ? { background: 'var(--navy-100)' } : undefined}>
                    <td style={{ minWidth: 150 }}>
                      <Link className="strong small" to={`/admin/employees/${o.user_id}`}>
                        {o.name}
                      </Link>
                      <div className="tiny muted">
                        {o.employee_code} · {EMPLOYMENT_LABEL[o.employment_type] || o.employment_type}
                        {o.role !== 'officer' ? ` · ${o.role}` : ''}
                      </div>
                      {o.phone && (
                        <a className="tiny" href={`tel:${o.phone}`}>
                          {o.phone}
                        </a>
                      )}
                    </td>
                    <td>
                      <div className="stack-sm" style={{ gap: 4, alignItems: 'flex-start' }}>
                        <StatusChip value={o.status} />
                        {o.on_break && <span className="tiny muted">{o.on_break.type} break, {o.on_break.minutes} min</span>}
                        {o.status === 'late' && o.job?.late_by_minutes != null && (
                          <span className="tiny" style={{ color: 'var(--warn)' }}>{o.job.late_by_minutes} min past start</span>
                        )}
                        {o.entry?.missed_checks > 0 && <Chip kind="danger">{o.entry.missed_checks} missed check-in</Chip>}
                      </div>
                    </td>
                    <td style={{ maxWidth: 240 }}>
                      {o.job ? (
                        <>
                          <div className="strong small">
                            {o.job.post_name} {o.job.armed && <Chip kind="brand">Armed</Chip>}
                          </div>
                          <div className="tiny muted">{o.job.site_name}</div>
                          <div className="tiny muted">{o.job.address}</div>
                        </>
                      ) : (
                        <span className="muted small">No shift in the next 12 hours</span>
                      )}
                    </td>
                    <td className="nowrap small">
                      {o.job?.starts_at ? (
                        <>
                          {fmtRange(o.job.starts_at, o.job.ends_at)}
                          <div className="tiny muted">
                            {o.job.starts_in_minutes != null ? `starts ${fmtRelative(o.job.starts_at)}` : fmtDay(o.job.starts_at)}
                          </div>
                        </>
                      ) : (
                        <span className="muted">No shift</span>
                      )}
                      {o.entry && (
                        <div className="tiny" style={{ marginTop: 3 }}>
                          In {fmtTime(o.entry.clock_in_at)} · {formatDuration(o.entry.minutes_on_post)}
                          {o.entry.late_minutes > 0 && (
                            <span style={{ color: 'var(--warn)', fontWeight: 650 }}> · {o.entry.late_minutes}m late</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <LocationCell o={o} staleAfter={data.rules.gpsStaleMinutes} />
                    </td>
                    <td className="num small nowrap">
                      {o.hours_today} / {o.hours_week}
                      {o.hours_week > 40 && (
                        <div>
                          <Chip kind="warn">Overtime</Chip>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        {o.location && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setFocusId(o.user_id)} title="Show on map">
                            <Icon name="pin" size={14} />
                            <span className="sr-only">Show {o.name} on the map</span>
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => setTracking(o)}>
                          <Icon name="gps" size={14} /> Track
                        </button>
                        {o.job?.latitude != null && (
                          <a
                            className="btn btn-ghost btn-sm"
                            href={directionsLink(o.job.latitude, o.job.longitude)}
                            target="_blank"
                            rel="noreferrer"
                            title="Directions to the post"
                          >
                            <Icon name="map" size={14} />
                            <span className="sr-only">Directions to {o.job.post_name}</span>
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {tracking && <TrackDialog officer={tracking} onClose={() => setTracking(null)} />}
    </div>
  );
}
