import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, tokenStore } from '../../lib/api.js';
import { fmtDate, fmtTime, toDateInput, fmtMoney } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Segmented, useToast,
} from '../../components/ui.jsx';
import { toHours } from '@shared/domain.js';
import CorrectionsTab from './CorrectionsTab.jsx';

/** Payroll periods people actually run. */
const PRESETS = {
  thisWeek: () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return { from: start, to: new Date() };
  },
  lastWeek: () => {
    const { from } = PRESETS.thisWeek();
    return { from: new Date(from.getTime() - 7 * 86400000), to: from };
  },
  twoWeeks: () => ({ from: new Date(Date.now() - 14 * 86400000), to: new Date() }),
  month: () => {
    const d = new Date();
    return { from: new Date(d.getFullYear(), d.getMonth(), 1), to: new Date() };
  },
};

export default function TimesheetsPage() {
  const toast = useToast();
  const [preset, setPreset] = useState('twoWeeks');
  const [range, setRange] = useState(PRESETS.twoWeeks());
  const [summary, setSummary] = useState(null);
  const [entries, setEntries] = useState([]);
  const [params, setParams] = useSearchParams();
  const view = ['summary', 'entries', 'corrections'].includes(params.get('view')) ? params.get('view') : 'summary';
  const setView = (v) => setParams(v === 'summary' ? {} : { view: v }, { replace: true });
  const [waiting, setWaiting] = useState(0);
  const loadWaiting = () => api.get('/time-corrections').then((d) => setWaiting(d.pending || 0), () => {});
  useEffect(() => {
    loadWaiting();
  }, []);

  useEffect(() => {
    setRange(PRESETS[preset] ? PRESETS[preset]() : range);
  }, [preset]);

  useEffect(() => {
    (async () => {
      const qs = `from=${range.from.toISOString()}&to=${range.to.toISOString()}`;
      try {
        const [s, e] = await Promise.all([
          api.get(`/admin/timesheets?${qs}`),
          api.get(`/admin/time-entries?${qs}`),
        ]);
        setSummary(s);
        setEntries(e.entries);
      } catch (err) {
        toast.error(err.message);
        setSummary({ rows: [] });
      }
    })();
  }, [range, toast]);

  const totals = useMemo(() => {
    const rows = summary?.rows || [];
    return {
      hours: Math.round(rows.reduce((n, r) => n + r.hours, 0) * 10) / 10,
      overtime: Math.round(rows.reduce((n, r) => n + r.overtime_hours, 0) * 10) / 10,
      late: rows.reduce((n, r) => n + r.late_shifts, 0),
      cost: rows.reduce((n, r) => n + (r.estimated_pay || 0), 0),
    };
  }, [summary]);

  const exportCsv = async () => {
    // The export needs the bearer token, so fetch it and save the blob.
    try {
      const res = await fetch(
        `/api/admin/export/timesheets.csv?from=${range.from.toISOString()}&to=${range.to.toISOString()}`,
        { headers: { Authorization: `Bearer ${tokenStore.get()}` } }
      );
      if (!res.ok) throw new Error('Export failed.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `usc-timesheets-${toDateInput(range.from)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Timesheet exported.');
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!summary) return <LoadingPage label="Building timesheets" />;

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Payroll</div>
          <h1>Timesheets</h1>
          <p className="lead">
            {fmtDate(range.from)} to {fmtDate(range.to)}
          </p>
        </div>
        <button className="btn btn-navy" onClick={exportCsv}>
          <Icon name="download" size={16} /> Export CSV
        </button>
      </div>

      <div className="row-between wrap">
        <Segmented
          value={preset}
          onChange={setPreset}
          options={[
            { value: 'thisWeek', label: 'This week' },
            { value: 'lastWeek', label: 'Last week' },
            { value: 'twoWeeks', label: 'Two weeks' },
            { value: 'month', label: 'Month' },
          ]}
        />
        <div className="row">
          <input
            type="date"
            aria-label="From date"
            value={toDateInput(range.from)}
            onChange={(e) => {
              setPreset('custom');
              setRange((r) => ({ ...r, from: new Date(e.target.value) }));
            }}
            style={{ width: 'auto' }}
          />
          <span className="muted small">to</span>
          <input
            type="date"
            aria-label="To date"
            value={toDateInput(range.to)}
            onChange={(e) => {
              setPreset('custom');
              setRange((r) => ({ ...r, to: new Date(e.target.value) }));
            }}
            style={{ width: 'auto' }}
          />
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Total hours" value={totals.hours} foot="All officers" />
        <Stat label="Overtime" value={totals.overtime} foot="Past 40h/week" alert={totals.overtime > 0} />
        <Stat label="Late shifts" value={totals.late} foot="Clock-in past grace" alert={totals.late > 0} />
        <Stat label="Estimated cost" value={totals.cost ? `$${totals.cost.toLocaleString()}` : '--'} foot="Where pay rates are set" />
      </div>

      <Segmented
        value={view}
        onChange={setView}
        options={[
          { value: 'summary', label: 'By officer' },
          { value: 'entries', label: `Every punch (${entries.length})` },
          { value: 'corrections', label: waiting ? `Corrections (${waiting})` : 'Corrections' },
        ]}
      />

      {view === 'corrections' ? (
        <CorrectionsTab onChanged={loadWaiting} />
      ) : view === 'summary' ? (
        <div className="card">
          {summary.rows.length === 0 ? (
            <Empty icon="clock" title="No hours in this period" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Officer</th>
                    <th className="num">Shifts</th>
                    <th className="num">Regular</th>
                    <th className="num">Overtime</th>
                    <th className="num">Total</th>
                    <th>Exceptions</th>
                    <th className="num">Est. pay</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.rows.map((r) => (
                    <tr key={r.user_id}>
                      <td className="mono">{r.employee_code}</td>
                      <td>
                        <Link to={`/admin/employees/${r.user_id}`} className="strong">
                          {r.officer}
                        </Link>
                      </td>
                      <td className="num">{r.shifts}</td>
                      <td className="num">{r.regular_hours}</td>
                      <td className="num" style={r.overtime_hours > 0 ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>
                        {r.overtime_hours || '--'}
                      </td>
                      <td className="num strong">{r.hours}</td>
                      <td>
                        <div className="row wrap" style={{ gap: 4 }}>
                          {r.late_shifts > 0 && <Chip kind="warn">{r.late_shifts} late</Chip>}
                          {r.geofence_issues > 0 && <Chip kind="danger">{r.geofence_issues} off site</Chip>}
                          {r.auto_closed > 0 && <Chip kind="danger">{r.auto_closed} auto-closed</Chip>}
                          {!r.late_shifts && !r.geofence_issues && !r.auto_closed && r.shifts > 0 && (
                            <Chip kind="ok">Clean</Chip>
                          )}
                        </div>
                      </td>
                      <td className="num">{r.estimated_pay ? `$${r.estimated_pay.toFixed(2)}` : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          {entries.length === 0 ? (
            <Empty icon="clock" title="No clock events in this period" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Officer</th>
                    <th>Post</th>
                    <th>In</th>
                    <th>Out</th>
                    <th className="num">Hrs</th>
                    <th>Location</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap small">{fmtDate(e.clock_in_at)}</td>
                      <td>
                        <Link to={`/admin/employees/${e.user_id}`}>{e.officer}</Link>
                      </td>
                      <td className="small">
                        {e.post_name}
                        <div className="tiny muted">{e.site_name}</div>
                      </td>
                      <td className="nowrap small">
                        {fmtTime(e.clock_in_at)}
                        {e.late_minutes > 0 && <Chip kind="warn">+{e.late_minutes}m</Chip>}
                      </td>
                      <td className="nowrap small">
                        {e.clock_out_at ? fmtTime(e.clock_out_at) : <Chip kind="brand" dot>On post</Chip>}
                      </td>
                      <td className="num">{e.minutes_worked != null ? toHours(e.minutes_worked) : '--'}</td>
                      <td>
                        <StatusChip value={e.clock_in_geofence} />
                      </td>
                      <td className="tiny muted">
                        {Boolean(e.auto_closed) && <Chip kind="danger">Auto-closed</Chip>}
                        {e.missed_checks > 0 && <Chip kind="danger">{e.missed_checks} missed</Chip>}
                        {e.adjustment_reason && <div className="truncate" style={{ maxWidth: 180 }}>{e.adjustment_reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
