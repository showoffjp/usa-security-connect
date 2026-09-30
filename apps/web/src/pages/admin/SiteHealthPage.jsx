import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Banner, Chip, Empty, Icon, LoadingPage, Stat, useToast } from '../../components/ui.jsx';
import { MonthlyReportView, monthName, recentMonths } from '../../components/MonthlyReport.jsx';
import { ScoreBar } from './ScorecardsPage.jsx';

const pct = (v) => (v == null ? '--' : `${v}%`);

function MonthPicker({ value, onChange }) {
  return (
    <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
      <label htmlFor="healthMonth">Month</label>
      <select id="healthMonth" value={value} onChange={(e) => onChange(e.target.value)}>
        {recentMonths().map((m) => (
          <option key={m} value={m}>
            {monthName(m)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Every site's month side by side, worst first. The same numbers each client
 * sees in their monthly report, so a manager knows before the client calls.
 */
export default function SiteHealthPage() {
  const toast = useToast();
  const [month, setMonth] = useState(recentMonths()[0]);
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api.get(`/admin/site-health?month=${month}`).then(
      (d) => alive && setData(d),
      (err) => {
        toast.error(err.message);
        alive && setData({ sites: [], needAttention: 0 });
      }
    );
    return () => {
      alive = false;
    };
  }, [month, toast]);

  const avg = (key) => {
    const vals = (data?.sites || []).map(key).filter((v) => v != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Reporting</div>
        <h1>Site health</h1>
        <p className="lead">Every property&rsquo;s month on one screen, worst first, with what is dragging each one down.</p>
      </div>
      <MonthPicker value={month} onChange={setMonth} />

      {!data ? (
        <LoadingPage label="Scoring every site" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Need attention" value={data.needAttention} foot={`of ${data.sites.length} sites`} alert={data.needAttention > 0} />
            <Stat label="Shifts covered" value={pct(avg((s) => s.coverage.pct))} foot="Average across sites" />
            <Stat label="Checkpoints scanned" value={pct(avg((s) => s.patrols.pct))} foot="Average across sites" />
            <Stat
              label="Serious incidents"
              value={data.sites.reduce((a, s) => a + s.incidents.serious, 0)}
              foot="High or critical"
            />
          </div>
          <div className="card">
            {data.sites.length === 0 ? (
              <Empty icon="building" title="No active sites" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th>Health</th>
                      <th>Covered</th>
                      <th>Checkpoints</th>
                      <th>Incidents</th>
                      <th>Open issues</th>
                      <th>Rating</th>
                      <th>Needs attention</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sites.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link className="strong" to={`/admin/site-health/${s.id}?month=${month}`}>
                            {s.name}
                          </Link>
                          <div className="tiny muted">{[s.client_name, s.city].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td>
                          <ScoreBar score={s.score} />
                        </td>
                        <td className="small">
                          {pct(s.coverage.pct)}
                          <div className="tiny muted">
                            {s.coverage.covered}/{s.coverage.scheduled} shifts
                          </div>
                        </td>
                        <td className="small">{pct(s.patrols.pct)}</td>
                        <td className="small">
                          {s.incidents.total}
                          {s.incidents.serious > 0 && (
                            <div>
                              <Chip kind="danger">{s.incidents.serious} serious</Chip>
                            </div>
                          )}
                        </td>
                        <td className="small">{s.issuesOpen || '--'}</td>
                        <td className="small">{s.rating ? `${s.rating.average} / 5` : '--'}</td>
                        <td className="small">
                          {s.concerns.length ? (
                            <ul className="concern-list">
                              {s.concerns.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          ) : (
                            <Chip kind="ok">All good</Chip>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card card-pad small muted">
            <strong className="strong" style={{ color: 'var(--ink)' }}>How health is scored.</strong> Out of 100. Up to 40
            comes off for shifts not covered (two points per percent), up to 25 for checkpoints not scanned, 5 for each
            serious incident (up to 15), 2 for each building issue still open (up to 10), and up to 10 when the client
            rates the month under 4.
          </div>
        </>
      )}
    </div>
  );
}

/** One site's month as its client sees it, for the manager. */
export function SiteMonthPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [month, setMonth] = useState(params.get('month') || recentMonths()[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    api.get(`/admin/sites/${id}/monthly?month=${month}`).then(
      (d) => alive && setData(d),
      (err) => alive && setError(err.message)
    );
    return () => {
      alive = false;
    };
  }, [id, month]);
  return (
    <div className="page stack">
      <div className="page-head no-print" style={{ marginBottom: 0 }}>
        <div>
          <div className="eyebrow">
            <Link to="/admin/site-health">Site health</Link>
          </div>
          <h1>{data ? data.site.name : 'Monthly report'}</h1>
          <p className="lead">The report this client reads in their portal.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => window.print()} disabled={!data}>
          <Icon name="print" size={16} /> Print / save PDF
        </button>
      </div>
      <div className="no-print">
        <MonthPicker value={month} onChange={setMonth} />
      </div>
      {error ? (
        <Banner kind="danger" title="The report did not load">
          {error}
        </Banner>
      ) : !data ? (
        <LoadingPage label="Building the report" />
      ) : (
        <MonthlyReportView data={data} />
      )}
    </div>
  );
}
