import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDay, fmtRange, fmtMoney, toDateInput } from '../../lib/format.js';
import { Chip, Empty, LoadingPage, Progress, Segmented, Stat, useToast } from '../../components/ui.jsx';

const money = (d) => (d == null ? '--' : fmtMoney(Math.round(d * 100)));

/** True on a phone-width screen, kept up to date as it turns. */
function useNarrow(maxWidth = 680) {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

/** The shift that tips an officer over, and what can still be done about it. */
function Tipping({ o, weekStart }) {
  const t = o.tipping_shift;
  if (!t) return <span className="tiny muted">{o.status === 'over' ? 'Over on hours already worked' : '--'}</span>;
  const startsLater = new Date(t.starts_at) > new Date();
  return (
    <>
      <div className="small">
        {fmtDay(t.starts_at)}, {fmtRange(t.starts_at, t.ends_at)}
      </div>
      <div className="tiny muted">
        {t.post_name} · {t.site_name} · {t.overtime_hours}h of overtime
      </div>
      {t.already_over ? (
        <div className="tiny muted">Already over before it starts</div>
      ) : startsLater ? (
        <Link className="btn btn-ghost btn-sm" style={{ marginTop: 4 }} to={`/admin/schedule?week=${weekStart}&shift=${t.shift_id}`}
          aria-label={`Find cover for ${o.name}'s shift at ${t.post_name}`}>
          Find cover
        </Link>
      ) : (
        <div className="tiny muted">Under way now</div>
      )}
    </>
  );
}

const Overtime = ({ o, threshold }) =>
  o.status === 'over' ? (
    <>
      <Chip kind="warn">{o.overtime_hours}h over</Chip>
      <div className="tiny muted">{money(o.premium)} extra</div>
    </>
  ) : (
    <Chip kind="">{(threshold - o.projected_hours).toFixed(1)}h to go</Chip>
  );

/** Monday of this week, or of next. */
function mondayOf(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return toDateInput(d);
}

/**
 * Who is heading past 40 hours in a payroll week, while there is still time
 * to do something about it: the shift that tips each one over opens on the
 * schedule, where the candidate list puts officers with hours to spare first.
 */
export default function OvertimePage() {
  const toast = useToast();
  const [week, setWeek] = useState('this');
  const [data, setData] = useState(null);
  const narrow = useNarrow();
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/admin/overtime?week=${mondayOf(week === 'this' ? 0 : 1)}`));
    } catch (err) {
      toast.error(err.message);
    }
  }, [week, toast]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Workforce</div>
        <h1>Overtime watch</h1>
        <p className="lead">
          W-2 officers paid by the hour heading past {data?.threshold_hours ?? 40} hours this payroll week: what they have worked plus what is
          still on the roster. Open the shift that tips them over to hand it to someone with hours to spare.
        </p>
      </div>

      <Segmented
        label="Week"
        value={week}
        onChange={(v) => {
          setData(null);
          setWeek(v);
        }}
        options={[
          { value: 'this', label: 'This week' },
          { value: 'next', label: 'Next week' },
        ]}
      />

      {!data ? (
        <LoadingPage label="Working out the week" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Over 40 hours" value={data.totals.over} foot={`${data.totals.near} more within ${data.near_hours} hours`} alert={data.totals.over > 0} />
            <Stat label="Overtime hours" value={`${data.totals.overtime_hours}h`} foot={`${fmtDate(data.week_start)} to ${fmtDate(data.week_end)}`} />
            <Stat label="Overtime premium" value={money(data.totals.premium)} foot="The half on top of straight time" />
            <Stat label="Still avoidable" value={data.totals.avoidable} foot="Tipped over by a shift not yet started" alert={data.totals.avoidable > 0} />
          </div>

          <div className="card">
            {data.officers.length === 0 ? (
              <Empty icon="clock" title="Nobody near overtime">
                Nobody is within {data.near_hours} hours of {data.threshold_hours} this week.
              </Empty>
            ) : narrow ? (
              <div className="list">
                {data.officers.map((o) => (
                  <div key={o.user_id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <div className="grow stack" style={{ gap: 6 }}>
                      <div className="row-between" style={{ gap: 8, alignItems: 'flex-start' }}>
                        <div>
                          <Link className="small strong" to={`/admin/employees/${o.user_id}`}>{o.name}</Link>
                          <div className="tiny muted">#{o.employee_code}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <Overtime o={o} threshold={data.threshold_hours} />
                        </div>
                      </div>
                      <div className="small">
                        <strong>{o.projected_hours}h</strong>
                        <span className="muted"> · {o.worked_hours}h worked + {o.scheduled_hours}h rostered</span>
                      </div>
                      <Progress value={Math.min(o.projected_hours, data.threshold_hours)} max={data.threshold_hours} ok={o.status !== 'over'}
                        label={`${o.name}: ${o.projected_hours} of ${data.threshold_hours} hours`} />
                      {o.tipping_shift && (
                        <div>
                          <div className="tiny strong">The shift that tips it</div>
                          <Tipping o={o} weekStart={data.week_start} />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <caption className="sr-only">Officers heading into overtime</caption>
                  <thead>
                    <tr>
                      <th>Officer</th>
                      <th className="num">Worked</th>
                      <th className="num">Still rostered</th>
                      <th>Projected</th>
                      <th className="num">Overtime</th>
                      <th>The shift that tips it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.officers.map((o) => {
                      return (
                        <tr key={o.user_id}>
                          <td>
                            <Link className="small strong nowrap" to={`/admin/employees/${o.user_id}`}>
                              {o.name}
                            </Link>
                            <div className="tiny muted">#{o.employee_code}</div>
                          </td>
                          <td className="num small">{o.worked_hours}h</td>
                          <td className="num small">
                            {o.scheduled_hours}h<div className="tiny muted">{o.shifts_left} shift{o.shifts_left === 1 ? '' : 's'}</div>
                          </td>
                          <td style={{ minWidth: 150 }}>
                            <div className="small strong">{o.projected_hours}h</div>
                            <Progress value={Math.min(o.projected_hours, data.threshold_hours)} max={data.threshold_hours} ok={o.status !== 'over'}
                              label={`${o.name}: ${o.projected_hours} of ${data.threshold_hours} hours`} />
                          </td>
                          <td className="num">
                            <Overtime o={o} threshold={data.threshold_hours} />
                          </td>
                          <td style={{ minWidth: 220 }}>
                            <Tipping o={o} weekStart={data.week_start} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
