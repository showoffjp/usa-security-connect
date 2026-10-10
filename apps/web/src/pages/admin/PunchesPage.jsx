import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadFile } from '../../lib/api.js';
import { fmtTime, fmtDateShort, toDateInput } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, StatusChip, Stat, useToast } from '../../components/ui.jsx';
import { formatDistance } from '@shared/domain.js';
import { useAuth } from '../../lib/auth.jsx';
import PunchLocationDialog from '../../components/PunchLocationDialog.jsx';

const TYPES = [
  { value: 'clock_in', label: 'Clock in', kind: 'ok' },
  { value: 'clock_out', label: 'Clock out', kind: 'navy' },
  { value: 'break_start', label: 'Break start', kind: 'info' },
  { value: 'break_end', label: 'Break end', kind: 'info' },
  { value: 'check_in', label: 'Check-in', kind: '' },
  { value: 'check_missed', label: 'Missed check-in', kind: 'danger' },
];
const KIND = Object.fromEntries(TYPES.map((t) => [t.value, t.kind]));

/** A correction to where a punch was made, in a sentence. */
const fixNote = (f) =>
  `Location corrected by ${f.by}: ${f.reason}${f.original.distance_m != null ? ` (the phone said ${formatDistance(f.original.distance_m)} from the post)` : ''}${f.count > 1 ? `, ${f.count} corrections` : ''}`;

export default function PunchesPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [fixing, setFixing] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [params] = useSearchParams();
  const [from, setFrom] = useState(toDateInput(new Date(Date.now() - 2 * 86400000)));
  const [to, setTo] = useState(toDateInput(new Date()));
  const [userId, setUserId] = useState(params.get('userId') || '');
  const [siteId, setSiteId] = useState('');
  // Answered check-ins are routine and outnumber everything else; they are
  // one click away rather than on by default.
  const [types, setTypes] = useState(TYPES.map((t) => t.value).filter((t) => t !== 'check_in'));
  const [onlyOutside, setOnlyOutside] = useState(false);
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(150);

  useEffect(() => {
    Promise.all([api.get('/admin/employees'), api.get('/admin/sites')])
      .then(([e, s]) => {
        setEmployees(e.employees);
        setSites(s.sites);
      })
      .catch((err) => toast.error(err.message));
  }, [toast]);

  const queryString = useMemo(() => {
    const q = new URLSearchParams({ from, to });
    if (userId) q.set('userId', userId);
    if (siteId) q.set('siteId', siteId);
    if (types.length && types.length < TYPES.length) q.set('type', types.join(','));
    return q.toString();
  }, [from, to, userId, siteId, types]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api
      .get(`/admin/punches?${queryString}`)
      .then((d) => alive && setData(d))
      .catch((err) => {
        toast.error(err.message);
        if (alive) setData((prev) => prev || { punches: [], counts: {}, total: 0 });
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [queryString, toast, reloadKey]);

  const allRows = useMemo(
    () => (data?.punches || []).filter((p) => !onlyOutside || p.geofence === 'outside'),
    [data, onlyOutside]
  );
  // A busy week is well over a thousand punches; render a page at a time.
  const rows = useMemo(() => allRows.slice(0, shown), [allRows, shown]);
  useEffect(() => setShown(150), [queryString, onlyOutside]);

  // Group by calendar day so a long list reads like a logbook.
  const days = useMemo(() => {
    const out = [];
    for (const p of rows) {
      const key = new Date(p.at).toDateString();
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, at: p.at, list: [] });
      out[out.length - 1].list.push(p);
    }
    return out;
  }, [rows]);

  const toggleType = (t) =>
    setTypes((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));

  const exportCsv = async () => {
    try {
      await downloadFile(`/admin/punches/export.csv?${queryString}`, `punches-${from}-to-${to}.csv`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!data) return <LoadingPage label="Loading punches" />;

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Workforce</div>
          <h1>Punch log</h1>
          <p className="lead">
            Every clock-in, clock-out, break and check-in, with where the officer was standing. When a phone's reading was wrong, correct it here.
          </p>
        </div>
        <div className="row wrap">
          <button className="btn btn-ghost" onClick={() => window.print()}>
            <Icon name="print" size={16} /> Print
          </button>
          <button className="btn btn-navy" onClick={exportCsv}>
            <Icon name="download" size={16} /> Export CSV
          </button>
        </div>
      </div>

      <div className="card card-pad stack-sm no-print">
        <div className="row wrap">
          <label className="small strong" htmlFor="p-from">From</label>
          <input id="p-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
          <label className="small strong" htmlFor="p-to">to</label>
          <input id="p-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
          <select aria-label="Officer" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All officers</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name} ({e.employee_code})
              </option>
            ))}
          </select>
          <select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {busy && <span className="tiny muted">Loading...</span>}
        </div>
        <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Punch types">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={types.includes(t.value)}
              className={`btn btn-sm ${types.includes(t.value) ? 'btn-navy' : 'btn-ghost'}`}
              onClick={() => toggleType(t.value)}
            >
              {t.label} ({data.counts?.[t.value] ?? 0})
            </button>
          ))}
          <label className="row small" style={{ gap: 6, marginLeft: 8 }}>
            <input type="checkbox" checked={onlyOutside} onChange={(e) => setOnlyOutside(e.target.checked)} style={{ width: 'auto' }} />
            Only punches outside the geofence
          </label>
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Punches" value={data.total} foot={`${data.range?.from} to ${data.range?.to}`} />
        <Stat label="Clock-ins" value={data.counts?.clock_in ?? 0} foot={`${data.counts?.clock_out ?? 0} clock-outs`} />
        <Stat label="Outside geofence" value={data.outsideGeofence ?? 0} alert={data.outsideGeofence > 0} foot="Punched away from the post" />
        <Stat label="Missed check-ins" value={data.counts?.check_missed ?? 0} alert={data.counts?.check_missed > 0} />
      </div>

      {rows.length === 0 ? (
        <Empty icon="clock" title="No punches in this range" />
      ) : (
        days.map((d) => (
          <div className="card" key={d.key}>
            <div className="card-head">
              <h3>{fmtDateShort(d.at)}</h3>
              <span className="small muted">{d.list.length} punches</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <caption className="sr-only">Punches on {fmtDateShort(d.at)}</caption>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Punch</th>
                    <th>Officer</th>
                    <th>Site &amp; post</th>
                    <th>Location check</th>
                    <th className="num">From post</th>
                    <th>Method</th>
                    <th>Notes</th>
                    <th className="no-print">
                      <span className="sr-only">Correct the location</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.list.map((p) => (
                    <tr key={p.id}>
                      <td className="nowrap strong small">{fmtTime(p.at)}</td>
                      <td>
                        <Chip kind={KIND[p.type]}>{p.label}</Chip>
                      </td>
                      <td>
                        <Link className="small strong" to={`/admin/employees/${p.user_id}`}>
                          {p.officer}
                        </Link>
                        <div className="tiny muted">
                          {p.employee_code} · {p.employment_type === '1099' ? '1099' : 'W-2'}
                        </div>
                      </td>
                      <td>
                        <div className="small">{p.site_name}</div>
                        <div className="tiny muted">{p.post_name}</div>
                      </td>
                      <td>
                        {p.geofence ? <StatusChip value={p.geofence} /> : p.latitude != null ? <Chip>GPS recorded</Chip> : <span className="tiny muted">--</span>}
                        {p.location_fix && (
                          <div style={{ marginTop: 4 }}>
                            <Chip kind="info">Corrected</Chip>
                          </div>
                        )}
                      </td>
                      <td className="num small">
                        {p.distance_m != null ? formatDistance(p.distance_m) : '--'}
                        {p.latitude != null && (
                          <div>
                            <a
                              className="tiny"
                              href={`https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Map
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="small">
                        {p.method ? p.method.toUpperCase() : '--'}
                        {p.device_id && <div className="tiny muted truncate" style={{ maxWidth: 140 }}>{p.device_id}</div>}
                      </td>
                      <td className="small" style={{ maxWidth: 260 }}>
                        {p.note || (!p.location_fix && <span className="muted">--</span>)}
                        {p.location_fix && <div className={p.note ? 'tiny muted' : 'small'}>{fixNote(p.location_fix)}</div>}
                      </td>
                      <td className="no-print">
                        {p.ref_id != null && p.user_id !== user?.id && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm nowrap"
                            onClick={() => setFixing({ kind: p.type, refId: p.ref_id })}
                            aria-label={`Correct the location of ${p.officer}'s ${p.label.toLowerCase()} at ${fmtTime(p.at)}`}
                          >
                            <Icon name="pin" size={14} /> Correct
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {fixing && (
        <PunchLocationDialog
          kind={fixing.kind}
          refId={fixing.refId}
          onClose={() => setFixing(null)}
          onSaved={() => {
            setFixing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {allRows.length > rows.length && (
        <div className="row no-print" style={{ justifyContent: 'center' }}>
          <span className="small muted">
            Showing {rows.length} of {allRows.length}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setShown((n) => n + 300)}>
            Show more
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setShown(allRows.length)}>
            Show all
          </button>
        </div>
      )}
    </div>
  );
}
