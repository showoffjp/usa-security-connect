import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Chip, Empty, LoadingPage, Segmented, Stat, useToast } from '../../components/ui.jsx';
import { CsvButton } from './SiteLogAdmin.jsx';

const band = (score) => (score === null ? '' : score >= 90 ? 'ok' : score >= 75 ? 'warn' : 'danger');
const pctText = (v) => (v === null || v === undefined ? '--' : `${Math.round(v)}%`);

export function ScoreBar({ score }) {
  if (score === null) return <span className="tiny muted">Not enough to judge</span>;
  const color = score >= 90 ? 'var(--ok)' : score >= 75 ? 'var(--warn)' : 'var(--danger)';
  return (
    <div className="row" style={{ gap: 8, minWidth: 120 }}>
      <strong style={{ width: 30, textAlign: 'right' }}>{score}</strong>
      <div
        className="progress grow"
        role="meter"
        aria-label="Score"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        style={{ minWidth: 60 }}
      >
        <span style={{ width: `${score}%`, background: color }} />
      </div>
    </div>
  );
}

/**
 * How each officer has actually worked over a period, from the punches,
 * check-ins, tours and flags - ranked, with the weighting spelled out so a
 * supervisor can explain any number to the officer it belongs to.
 */
export default function ScorecardsPage() {
  const toast = useToast();
  const [days, setDays] = useState('30');
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api.get(`/admin/scorecards?days=${days}`).then(
      (d) => alive && setData(d),
      (err) => {
        toast.error(err.message);
        alive && setData({ cards: [], averageScore: null });
      }
    );
    return () => {
      alive = false;
    };
  }, [days, toast]);

  const cards = useMemo(() => {
    if (!data) return [];
    if (filter === 'attention') return data.cards.filter((c) => c.score !== null && c.score < 75);
    return data.cards;
  }, [data, filter]);

  const attention = data?.cards.filter((c) => c.score !== null && c.score < 75).length ?? 0;
  const perfect = data?.cards.filter((c) => c.score === 100).length ?? 0;
  const late = data?.cards.reduce((n, c) => n + (c.shifts.worked - c.shifts.onTime), 0) ?? 0;

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Reporting</div>
        <h1>Officer scorecards</h1>
        <p className="lead">Punctuality, attendance, check-ins and compliance for every officer who worked, ranked.</p>
      </div>

      <div className="row wrap" style={{ gap: 10 }}>
        <Segmented
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'attention', label: `Needs attention${attention ? ` (${attention})` : ''}` },
          ]}
        />
        <CsvButton path={`/admin/scorecards?days=${days}`} filename={`officer-scorecards-${days}-days`} />
      </div>

      {!data ? (
        <LoadingPage label="Scoring" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Average score" value={data.averageScore ?? '--'} foot={`${data.cards.length} officers`} />
            <Stat label="Needs attention" value={attention} foot="Scored under 75" alert={attention > 0} />
            <Stat label="Perfect" value={perfect} foot="Scored 100" />
            <Stat label="Late clock-ins" value={late} foot={`More than ${data.graceMinutes} min after the start`} alert={late > 0} />
          </div>

          <div className="card">
            {cards.length === 0 ? (
              <Empty icon="chart" title={filter === 'attention' ? 'Nobody needs attention' : 'No shifts worked in this period'} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Officer</th>
                      <th>Score</th>
                      <th>On time</th>
                      <th>Shifts</th>
                      <th>Check-ins</th>
                      <th>Tours</th>
                      <th>Incidents</th>
                      <th>Flags</th>
                      <th>Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map((c, i) => (
                      <tr key={c.id}>
                        <td className="small muted">{i + 1}</td>
                        <td>
                          <Link className="strong" to={`/admin/employees/${c.id}`}>
                            {c.name}
                          </Link>
                          <div className="tiny muted">
                            {c.employee_code} · {c.role === 'supervisor' ? 'Supervisor' : c.employment_type === '1099' ? '1099' : 'W-2'}
                          </div>
                        </td>
                        <td>
                          <ScoreBar score={c.score} />
                        </td>
                        <td className="small">
                          {pctText(c.shifts.onTimePct)}
                          {c.shifts.avgLateMin > 0 && <div className="tiny muted">late by {c.shifts.avgLateMin} min avg</div>}
                        </td>
                        <td className="small">
                          {c.shifts.worked}/{c.shifts.due}
                          {c.shifts.missed > 0 && (
                            <div>
                              <Chip kind="danger">{c.shifts.missed} missed</Chip>
                            </div>
                          )}
                        </td>
                        <td className="small">
                          {pctText(c.checkIns.answeredPct)}
                          {c.checkIns.missed > 0 && <div className="tiny muted">{c.checkIns.missed} missed</div>}
                        </td>
                        <td className="small">{c.tours.runs ? `${c.tours.completed}/${c.tours.runs}` : '--'}</td>
                        <td className="small">{c.incidents || '--'}</td>
                        <td>
                          {c.flags.total ? (
                            <Chip kind={c.flags.critical ? 'danger' : 'warn'}>{c.flags.total}</Chip>
                          ) : (
                            <span className="small muted">--</span>
                          )}
                        </td>
                        <td className="small">{c.hours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card card-pad small muted">
            <strong className="strong" style={{ color: 'var(--ink)' }}>How the score works.</strong> Out of 100:
            punctuality 35 (clocked in within {data.graceMinutes} minutes of the shift start), attendance 25 (shifts worked
            out of shifts due), check-ins 25 (answered in their window; a late answer counts half) and a clean record 15
            (fewer compliance flags per shift). A part with nothing to judge is left out and the rest scaled up, so nobody is
            marked down for what never came up. <Chip kind={band(90)}>90+</Chip> <Chip kind={band(80)}>75-89</Chip>{' '}
            <Chip kind={band(50)}>under 75</Chip>
          </div>
        </>
      )}
    </div>
  );
}
