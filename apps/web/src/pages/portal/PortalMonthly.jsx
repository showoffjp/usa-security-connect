import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { clientApi } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/format.js';
import { Banner, Chip, Empty, Icon, LoadingPage, Stat } from '../../components/ui.jsx';

const SEVERITY_KIND = { critical: 'danger', high: 'danger', medium: 'warn', low: '' };
const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The last twelve months, newest first, as YYYY-MM. */
function recentMonths() {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 12; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}
const monthName = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
const pct = (v) => (v == null ? '--' : `${v}%`);

/**
 * One property's month in a page: coverage, patrols, incidents, who came
 * through and what was fixed. Laid out to print for the client's file.
 */
export default function PortalMonthly({ sites }) {
  const months = recentMonths();
  const [siteId, setSiteId] = useState(sites[0]?.id ?? null);
  const [month, setMonth] = useState(months[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!siteId) return undefined;
    let alive = true;
    setData(null);
    setError('');
    clientApi.get(`/client/monthly?siteId=${siteId}&month=${month}`).then(
      (d) => alive && setData(d),
      (err) => alive && setError(err.message)
    );
    return () => {
      alive = false;
    };
  }, [siteId, month]);

  return (
    <div className="page">
      <div className="page-head no-print">
        <div>
          <div className="eyebrow">
            <Link to="/portal/report">Daily reports</Link>
          </div>
          <h1>Monthly service report</h1>
          <p className="muted">One property&rsquo;s month on a page, ready to print or save as a PDF for your records.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => window.print()} disabled={!data}>
          <Icon name="print" size={16} /> Print / save PDF
        </button>
      </div>

      <div className="row wrap no-print" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        {sites.length > 1 && (
          <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
            <label htmlFor="monthlySite">Property</label>
            <select id="monthlySite" value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
          <label htmlFor="monthlyMonth">Month</label>
          <select id="monthlyMonth" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <Banner kind="danger" title="The report did not load">
          {error}
        </Banner>
      ) : !data ? (
        <LoadingPage label="Building the report" />
      ) : (
        <div className="stack monthly-report">
          <div className="card card-pad">
            <div className="eyebrow">USA Security &amp; Protection Group</div>
            <h2 style={{ margin: '4px 0 2px' }}>{data.site.name}</h2>
            <p className="muted small" style={{ marginBottom: 0 }}>
              {[data.site.address, data.site.city, data.site.state].filter(Boolean).join(', ')}
              <br />
              Service report for {monthName(data.month)}
              {data.partial ? ' (month to date)' : ''}
            </p>
          </div>

          <div className="grid grid-4">
            <Stat
              label="Shifts covered"
              value={pct(data.coverage.pct)}
              foot={data.coverage.scheduled ? `${data.coverage.covered} of ${data.coverage.scheduled} shifts` : 'No shifts scheduled'}
              alert={data.coverage.pct != null && data.coverage.pct < 95}
            />
            <Stat label="Hours on site" value={data.coverage.hours} foot="Clocked by our officers" />
            <Stat
              label="Checkpoints scanned"
              value={pct(data.patrols.pct)}
              foot={`${data.patrols.runs} patrols, ${data.patrols.scanned} of ${data.patrols.checkpoints} checkpoints`}
            />
            <Stat
              label="Incidents"
              value={data.incidents.total}
              foot={
                data.incidents.total
                  ? Object.entries(data.incidents.bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')
                  : 'Nothing reported'
              }
              alert={Boolean(data.incidents.bySeverity.high || data.incidents.bySeverity.critical)}
            />
          </div>

          <section className="card">
            <div className="card-head">
              <h3>Coverage by post</h3>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Post</th>
                    <th>Shifts</th>
                    <th>Covered</th>
                    <th>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {data.posts.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong> <span className="tiny muted">{p.post_code}</span>
                      </td>
                      <td>{p.scheduled}</td>
                      <td>
                        {p.covered}
                        {p.scheduled > p.covered && <Chip kind="danger">{p.scheduled - p.covered} missed</Chip>}
                      </td>
                      <td>{p.hours}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Incidents</h3>
              <span className="small muted">{data.incidents.total}</span>
            </div>
            {data.incidents.list.length === 0 ? (
              <Empty icon="check" title="No incidents this month" />
            ) : (
              <ul className="list">
                {data.incidents.list.map((i) => (
                  <li key={i.id} className="list-item" style={{ cursor: 'default' }}>
                    <div className="grow">
                      <div className="row wrap" style={{ gap: 6 }}>
                        <strong className="small">{label(i.category)}</strong>
                        <Chip kind={SEVERITY_KIND[i.severity] ?? ''}>{label(i.severity)}</Chip>
                        {i.police_notified && <Chip kind="info">Police notified</Chip>}
                      </div>
                      <div className="tiny muted">
                        {i.ref_number} · {fmtDateTime(i.occurred_at)}
                        {i.location_text ? ` · ${i.location_text}` : ''} · {label(i.status)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card card-pad">
            <h3 style={{ marginTop: 0 }}>On the property</h3>
            <dl className="kv monthly-kv">
              <dt>Visitors signed in</dt>
              <dd>{data.visitors}</dd>
              <dt>Parking violations</dt>
              <dd>{data.violations}</dd>
              <dt>Activity log entries</dt>
              <dd>{data.activity}</dd>
              <dt>Checkpoints skipped</dt>
              <dd>{data.patrols.skipped}</dd>
              <dt>Supervisor visits</dt>
              <dd>{data.supervisorVisits}</dd>
              <dt>Lost property logged</dt>
              <dd>{data.found}</dd>
              <dt>Building issues</dt>
              <dd>
                {data.issues.reported} reported, {data.issues.fixed} fixed, {data.issues.open} still open
              </dd>
              <dt>Your rating</dt>
              <dd>{data.rating ? `${data.rating.average} out of 5` : 'Not rated yet'}</dd>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
