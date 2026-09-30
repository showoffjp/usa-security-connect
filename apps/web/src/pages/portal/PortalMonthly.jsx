import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { clientApi } from '../../lib/api.js';
import { Banner, Icon, LoadingPage } from '../../components/ui.jsx';
import { MonthlyReportView, monthName, recentMonths } from '../../components/MonthlyReport.jsx';

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
        <MonthlyReportView data={data} />
      )}
    </div>
  );
}
