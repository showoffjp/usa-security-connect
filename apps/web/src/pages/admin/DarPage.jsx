import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtTime, fmtDate, toDateInput, fmtMoney } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Stat, useToast, Shield,
} from '../../components/ui.jsx';
import { FLAG_LABEL } from '@shared/domain.js';

/**
 * Daily Activity Report.
 *
 * The page is laid out to print cleanly onto letter paper - the app chrome is
 * hidden by the print stylesheet - because a DAR is usually emailed to the
 * client as a PDF at the end of each day.
 */
export default function DarPage() {
  const toast = useToast();
  const [date, setDate] = useState(toDateInput(new Date()));
  const [siteId, setSiteId] = useState('');
  const [sites, setSites] = useState([]);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setData(null);
    try {
      const qs = new URLSearchParams({ date });
      if (siteId) qs.set('siteId', siteId);
      setData(await api.get(`/reports/dar?${qs}`));
    } catch (err) {
      toast.error(err.message);
    }
  }, [date, siteId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get('/admin/sites').then((r) => setSites(r.sites)).catch(() => {});
  }, []);

  if (!data) return <LoadingPage label="Assembling the report" />;

  const s = data.summary;

  return (
    <div className="page stack">
      {/* Controls are hidden when printing. */}
      <div className="row-between wrap btn-row">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Client reporting</div>
          <h1>Daily activity report</h1>
          <p className="lead">Built from the day's clock, tour and incident data. No re-typing.</p>
        </div>
        <div className="row wrap">
          <input
            type="date"
            aria-label="Report date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ width: 'auto' }}
          />
          <select
            aria-label="Filter by site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="">All sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
          <button className="btn btn-navy" onClick={() => window.print()}>
            <Icon name="download" size={16} /> Print / PDF
          </button>
        </div>
      </div>

      {/* --------------------------------------------------- letterhead -- */}
      <div className="card card-pad">
        <div className="row-between wrap">
          <div className="row">
            <Shield size={42} />
            <div>
              <div className="strong" style={{ fontSize: '1.1rem' }}>
                USA Security &amp; Protection Group
              </div>
              <div className="small muted">
                Daily Activity Report &middot; Florida licensed agency B 3400341
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="strong">{fmtDate(data.date)}</div>
            <div className="small muted">{data.site ? data.site.name : 'All sites'}</div>
            {data.site?.client && <div className="tiny muted">{data.site.client}</div>}
          </div>
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Officers" value={s.officers} foot={`${s.shifts} shifts`} />
        <Stat label="Hours on post" value={s.hours} foot="Billable time" />
        <Stat label="Checkpoints" value={s.checkpointsScanned} foot={`${s.toursCompleted} tours completed`} />
        <Stat label="Incidents" value={s.incidents} foot={`${s.supervisorVisits} supervisor visits`} alert={s.incidents > 0} />
      </div>

      <div className="grid grid-4">
        <Stat label="Check-ins answered" value={s.checkInsAnswered} foot="Proof of life" />
        <Stat label="Check-ins missed" value={s.checkInsMissed} foot="Followed up" alert={s.checkInsMissed > 0} />
        <Stat label="Exceptions" value={s.exceptions} foot="Late, no-show, geofence" alert={s.exceptions > 0} />
        <Stat label="Visitors" value={s.visitors ?? 0} foot="Signed in at the post" />
      </div>

      {/* --------------------------------------------------------- posts -- */}
      <div className="card">
        <div className="card-head">
          <h3>Coverage</h3>
          <span className="small muted">Who stood which post</span>
        </div>
        {data.shifts.length === 0 ? (
          <Empty icon="users" title="No shifts worked on this date" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Officer</th>
                  <th>Site</th>
                  <th>Post</th>
                  <th>In</th>
                  <th>Out</th>
                  <th className="num">Hours</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {data.shifts.map((shift) => (
                  <tr key={shift.id}>
                    <td className="small strong">{shift.officer}</td>
                    <td className="small muted">{shift.site_name}</td>
                    <td className="small">{shift.post_name}</td>
                    <td className="small nowrap">
                      {fmtTime(shift.clock_in_at)}
                      {shift.late_minutes > 0 && <Chip kind="warn">+{shift.late_minutes}m</Chip>}
                    </td>
                    <td className="small nowrap">
                      {shift.clock_out_at ? fmtTime(shift.clock_out_at) : <Chip kind="brand">On post</Chip>}
                    </td>
                    <td className="num">{shift.hours || '--'}</td>
                    <td>
                      <StatusChip value={shift.clock_in_geofence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* --------------------------------------------------------- tours -- */}
      <div className="card">
        <div className="card-head">
          <h3>Patrols</h3>
          <span className="small muted">{s.checkpointsScanned} checkpoints scanned</span>
        </div>
        {data.tours.length === 0 ? (
          <Empty icon="route" title="No tours walked on this date" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Tour</th>
                  <th>Officer</th>
                  <th>Checkpoints</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.tours.map((tour) => (
                  <tr key={tour.id}>
                    <td className="small nowrap">{fmtTime(tour.started_at)}</td>
                    <td className="small strong">{tour.tour_name}</td>
                    <td className="small">{tour.officer}</td>
                    <td className="small">
                      {tour.done}/{tour.total}
                      {tour.skipped > 0 && <Chip kind="warn">{tour.skipped} skipped</Chip>}
                    </td>
                    <td>
                      <StatusChip value={tour.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------- incidents -- */}
      <div className="card">
        <div className="card-head">
          <h3>Incidents</h3>
        </div>
        {data.incidents.length === 0 ? (
          <Empty icon="check" title="No incidents reported">
            A quiet day is still a reportable day.
          </Empty>
        ) : (
          <div className="list">
            {data.incidents.map((incident) => (
              <div key={incident.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 7 }}>
                    <span className="mono small strong">{incident.ref_number}</span>
                    <StatusChip value={incident.severity} />
                    {incident.category && <Chip kind="navy">{incident.category}</Chip>}
                    <span className="tiny muted">{fmtTime(incident.occurred_at)}</span>
                  </div>
                  <div className="small" style={{ marginTop: 3 }}>
                    <strong>{incident.location_text || incident.site_name}</strong> - reported by {incident.officer}
                  </div>
                  <p className="small" style={{ margin: '4px 0 0', color: 'var(--ink-3)' }}>
                    {incident.what_happened}
                  </p>
                  {incident.resolution && (
                    <p className="small" style={{ margin: '4px 0 0', color: 'var(--ink-3)' }}>
                      <strong>Resolution:</strong> {incident.resolution}
                    </p>
                  )}
                  {incident.cost_recovery_cents != null && (
                    <div className="tiny muted">
                      Cost recovery: {fmtMoney(incident.cost_recovery_cents)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ----------------------------------------------------- visitors -- */}
      {data.visitors?.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Visitors</h3>
            <span className="small muted">{data.visitors.length}</span>
          </div>
          <div className="list">
            {data.visitors.map((v) => (
              <div key={v.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="small strong">
                    {v.full_name}
                    {v.company ? ` (${v.company})` : ''} - {v.purpose}
                  </div>
                  <div className="tiny muted">
                    {v.site_name}
                    {v.host ? ` · for ${v.host}` : ''}
                    {v.vehicle_plate ? ` · ${v.vehicle_plate}` : ''}
                    {v.logged_by_name ? ` · logged by ${v.logged_by_name}` : ''}
                  </div>
                </div>
                <div className="nowrap small muted">
                  {fmtTime(v.arrived_at)} - {v.departed_at ? fmtTime(v.departed_at) : 'inside'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------- vehicles -- */}
      {data.vehicles?.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Parking enforcement</h3>
            <span className="small muted">{data.vehicles.length}</span>
          </div>
          <div className="list">
            {data.vehicles.map((v) => (
              <div key={v.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="small strong">
                    <span className="mono">{v.plate}</span> - {v.violation.replace('_', ' ')}, {v.action}
                  </div>
                  <div className="tiny muted">
                    {v.site_name}
                    {v.location_text ? ` · ${v.location_text}` : ''}
                    {v.logged_by_name ? ` · ${v.logged_by_name}` : ''}
                  </div>
                </div>
                <div className="nowrap small muted">{fmtTime(v.occurred_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------- visits -- */}
      {data.visits.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Supervisor visits</h3>
          </div>
          <div className="list">
            {data.visits.map((visit) => (
              <div key={visit.id} className="list-item" style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="small strong">
                    {visit.supervisor_name} visited {visit.post_name || visit.site_name}
                  </div>
                  <div className="tiny muted">
                    {fmtTime(visit.visited_at)}
                    {visit.officer_name ? ` - officer on post: ${visit.officer_name}` : ''}
                  </div>
                  {visit.notes && <div className="tiny" style={{ color: 'var(--ink-3)' }}>{visit.notes}</div>}
                </div>
                {visit.rating && <Chip kind={visit.rating >= 4 ? 'ok' : 'warn'}>{visit.rating}/5</Chip>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --------------------------------------------------- exceptions -- */}
      {data.exceptions.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Exceptions</h3>
            <span className="small muted">Internal - review before sending to the client</span>
          </div>
          <div className="list">
            {data.exceptions.map((flag) => (
              <div key={flag.id} className="list-item" style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="small strong">{FLAG_LABEL[flag.type] || flag.type}</div>
                  <div className="tiny muted">
                    {flag.officer} - {fmtTime(flag.occurred_at)}
                  </div>
                </div>
                <StatusChip value={flag.severity} />
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="tiny muted center">
        Generated by USA Security Connect on {new Date().toLocaleString()}. Times are local.
      </p>
    </div>
  );
}
