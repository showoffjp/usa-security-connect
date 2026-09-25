import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadFile } from '../../lib/api.js';
import { fmtMoney, fmtDateShort, fmtDateTime, toDateInput } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Stat, useToast } from '../../components/ui.jsx';
import { RankedBars, TimeColumns } from '../../components/BarChart.jsx';

/* ------------------------------------------------------------ helpers -- */

const monday = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const PRESETS = [
  { value: 'this_week', label: 'This week', range: () => [monday(new Date()), new Date()] },
  { value: 'last_week', label: 'Last week', range: () => [addDays(monday(new Date()), -7), addDays(monday(new Date()), -1)] },
  { value: 'last_14', label: 'Last 14 days', range: () => [addDays(new Date(), -13), new Date()] },
  { value: 'this_month', label: 'This month', range: () => [new Date(new Date().getFullYear(), new Date().getMonth(), 1), new Date()] },
  {
    value: 'last_month',
    label: 'Last month',
    range: () => [
      new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
      new Date(new Date().getFullYear(), new Date().getMonth(), 0),
    ],
  },
  { value: 'last_30', label: 'Last 30 days', range: () => [addDays(new Date(), -29), new Date()] },
];

export function formatCell(value, type) {
  if (value == null || value === '') return '--';
  switch (type) {
    case 'money':
      return fmtMoney(Math.round(value * 100));
    case 'rate':
      return `${fmtMoney(Math.round(value * 100))}/h`;
    case 'hours':
      return Number(value).toFixed(2);
    case 'percent':
      return `${value}%`;
    case 'int':
      return Number(value).toLocaleString();
    case 'date':
      return fmtDateShort(value);
    case 'datetime':
      return fmtDateTime(value);
    default:
      return String(value);
  }
}

const numeric = (type) => ['money', 'rate', 'hours', 'percent', 'int'].includes(type);

/* --------------------------------------------------------------- page -- */

export default function ReportsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [catalogue, setCatalogue] = useState([]);
  const [kind, setKind] = useState(params.get('report') || 'hours-by-officer');
  const [preset, setPreset] = useState('last_14');
  const [from, setFrom] = useState(toDateInput(addDays(new Date(), -13)));
  const [to, setTo] = useState(toDateInput(new Date()));
  const [siteId, setSiteId] = useState('');
  const [userId, setUserId] = useState(params.get('userId') || '');
  const [employmentType, setEmploymentType] = useState('');
  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState(null);

  useEffect(() => {
    Promise.all([api.get('/admin/reports'), api.get('/admin/sites'), api.get('/admin/employees')])
      .then(([r, s, e]) => {
        setCatalogue(r.reports);
        setSites(s.sites);
        setEmployees(e.employees);
      })
      .catch((err) => toast.error(err.message));
  }, [toast]);

  const choosePreset = (value) => {
    setPreset(value);
    const p = PRESETS.find((x) => x.value === value);
    if (p) {
      const [a, b] = p.range();
      setFrom(toDateInput(a));
      setTo(toDateInput(b));
    }
  };

  const queryString = useMemo(() => {
    const q = new URLSearchParams({ from, to });
    if (siteId) q.set('siteId', siteId);
    if (userId) q.set('userId', userId);
    if (employmentType) q.set('employmentType', employmentType);
    return q.toString();
  }, [from, to, siteId, userId, employmentType]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setSort(null);
    api
      .get(`/admin/reports/${kind}?${queryString}`)
      .then((r) => alive && setReport(r))
      .catch((err) => {
        toast.error(err.message);
        if (alive) setReport(null);
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [kind, queryString, toast]);

  const pick = (id) => {
    setKind(id);
    params.set('report', id);
    setParams(params, { replace: true });
  };

  const rows = useMemo(() => {
    if (!report) return [];
    if (!sort) return report.rows;
    const col = report.columns.find((c) => c.key === sort.key);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...report.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x == null) return 1;
      if (y == null) return -1;
      return (numeric(col?.type) ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [report, sort]);

  const chartData = useMemo(() => {
    const c = report?.chart;
    if (!c) return null;
    if (c.series === 'time') {
      return report.rows.map((r) => ({
        label: fmtDateShort(r[c.label]),
        short: fmtDateShort(r[c.label]).replace(/,.*$/, ''),
        value: Number(r[c.value]) || 0,
      }));
    }
    const map = new Map();
    for (const r of report.rows) {
      const k = r[c.label] || 'Unknown';
      map.set(k, (map.get(k) || 0) + (Number(r[c.value]) || 0));
    }
    return [...map.entries()].map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }));
  }, [report]);

  const groups = useMemo(() => {
    const out = new Map();
    for (const r of catalogue) {
      if (!out.has(r.group)) out.set(r.group, []);
      out.get(r.group).push(r);
    }
    return [...out.entries()];
  }, [catalogue]);

  const exportCsv = async () => {
    try {
      await downloadFile(`/admin/reports/${kind}/export.csv?${queryString}`, `${kind}-${from}-to-${to}.csv`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const chartFormat = (v) => formatCell(v, report?.chart?.type || 'hours');

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Reporting</div>
          <h1>Reports</h1>
          <p className="lead">Hours, pay, billing, attendance and GPS compliance - for any period, site, officer or classification.</p>
        </div>
        <div className="row wrap no-print">
          <button className="btn btn-ghost" onClick={() => window.print()} disabled={!report}>
            <Icon name="print" size={16} /> Print
          </button>
          <button className="btn btn-navy" onClick={exportCsv} disabled={!report}>
            <Icon name="download" size={16} /> Export CSV
          </button>
        </div>
      </div>

      <div className="reports-layout">
        <nav className="card no-print" aria-label="Reports" style={{ alignSelf: 'start' }}>
          {groups.map(([group, list]) => (
            <div key={group}>
              <div className="tiny strong muted" style={{ padding: '12px 14px 4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {group}
              </div>
              {list.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-current={kind === r.id ? 'page' : undefined}
                  onClick={() => pick(r.id)}
                  className="report-link"
                >
                  <span className="small strong">{r.title}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="stack" style={{ minWidth: 0 }}>
          <div className="card card-pad stack-sm no-print">
            <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Period">
              {PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={preset === p.value}
                  className={`btn btn-sm ${preset === p.value ? 'btn-navy' : 'btn-ghost'}`}
                  onClick={() => choosePreset(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="row wrap">
              <label className="small strong" htmlFor="r-from">From</label>
              <input
                id="r-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => {
                  setPreset('custom');
                  setFrom(e.target.value);
                }}
                style={{ width: 'auto' }}
              />
              <label className="small strong" htmlFor="r-to">to</label>
              <input
                id="r-to"
                type="date"
                value={to}
                min={from}
                onChange={(e) => {
                  setPreset('custom');
                  setTo(e.target.value);
                }}
                style={{ width: 'auto' }}
              />
              <select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: 'auto' }}>
                <option value="">All sites</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select aria-label="Officer" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 'auto' }}>
                <option value="">All officers</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.full_name}
                  </option>
                ))}
              </select>
              <select aria-label="Classification" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} style={{ width: 'auto' }}>
                <option value="">W-2 and 1099</option>
                <option value="w2">W-2 only</option>
                <option value="1099">1099 only</option>
              </select>
              {busy && <span className="tiny muted">Running...</span>}
            </div>
          </div>

          {!report ? (
            busy ? <LoadingPage label="Running the report" /> : <Empty icon="chart" title="Pick a report" />
          ) : (
            <>
              <div>
                <h2>{report.report.title}</h2>
                <p className="small muted" style={{ margin: '4px 0 0' }}>
                  {report.report.description} · {fmtDateShort(report.filters.from)} to {fmtDateShort(report.filters.to)}
                  {siteId && ` · ${sites.find((s) => String(s.id) === siteId)?.name || ''}`}
                  {userId && ` · ${employees.find((e) => String(e.id) === userId)?.full_name || ''}`}
                  {employmentType && ` · ${employmentType === '1099' ? '1099 only' : 'W-2 only'}`}
                </p>
              </div>

              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                {report.summary.map((s) => (
                  <Stat key={s.label} label={s.label} value={formatCell(s.value, s.type)} />
                ))}
              </div>

              {chartData && chartData.length > 0 && (
                <div className="card card-pad">
                  <h3 style={{ marginBottom: 12 }}>
                    {report.columns.find((c) => c.key === report.chart.value)?.label || 'Value'}
                    {report.chart.series === 'time' ? ' by day' : ` by ${report.chart.label}`}
                    {report.chart.series !== 'time' && chartData.length > 12 && <span className="small muted"> (top 12)</span>}
                  </h3>
                  {report.chart.series === 'time' ? (
                    <TimeColumns data={chartData} format={chartFormat} title={`${report.report.title} by day`} />
                  ) : (
                    <RankedBars data={chartData} format={chartFormat} title={report.report.title} />
                  )}
                </div>
              )}

              <div className="card">
                {rows.length === 0 ? (
                  <Empty icon="chart" title="Nothing in this period">
                    Try a longer range or remove a filter.
                  </Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="data report-table">
                      <caption className="sr-only">{report.report.title}</caption>
                      <thead>
                        <tr>
                          {report.columns.map((c) => {
                            const active = sort?.key === c.key;
                            return (
                              <th
                                key={c.key}
                                className={numeric(c.type) ? 'num' : undefined}
                                aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                              >
                                <button
                                  type="button"
                                  className="th-sort"
                                  onClick={() =>
                                    setSort((s) =>
                                      s?.key === c.key
                                        ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
                                        : { key: c.key, dir: numeric(c.type) ? 'desc' : 'asc' }
                                    )
                                  }
                                >
                                  {c.label}
                                  <span aria-hidden="true">{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                                </button>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i}>
                            {report.columns.map((c) => {
                              const v = r[c.key];
                              const warn = c.warnAbove != null && Number(v) > c.warnAbove;
                              return (
                                <td
                                  key={c.key}
                                  className={numeric(c.type) ? 'num' : undefined}
                                  style={warn ? { color: 'var(--warn)', fontWeight: 650 } : undefined}
                                >
                                  {c.link && r[c.link] ? (
                                    <Link to={`/admin/employees/${r[c.link]}`}>{formatCell(v, c.type)}</Link>
                                  ) : (
                                    formatCell(v, c.type)
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                      {Object.keys(report.totals || {}).length > 0 && (
                        <tfoot>
                          <tr>
                            {report.columns.map((c, i) => (
                              <td key={c.key} className={numeric(c.type) ? 'num strong' : 'strong'}>
                                {i === 0 ? `Total (${report.rows.length})` : report.totals[c.key] != null ? formatCell(report.totals[c.key], c.type) : ''}
                              </td>
                            ))}
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                )}
              </div>

              {report.notes?.length > 0 && (
                <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                  {report.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <p className="tiny muted">Generated {fmtDateTime(report.generated_at)}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
