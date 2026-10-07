import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDay, fmtRange, fmtTime, toDateInput } from '../../lib/format.js';
import { Chip, Empty, LoadingPage, Segmented, Stat, useToast } from '../../components/ui.jsx';
import { RULES } from '@shared/domain.js';

const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Monday of the week a shift falls in, for opening the schedule there. */
function weekOf(iso) {
  const d = new Date(iso);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateInput(d);
}

/**
 * Shifts on the roster that leave an officer short of rest, over the hours in
 * a day, or over the days in a row. Each is listed once, on the shift that
 * tips it; reassign it, or move it, from the schedule.
 */
export default function FatiguePage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const focus = Number(params.get('shift')) || null;
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/admin/fatigue?days=${days}`));
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast, days]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (data && focus) document.getElementById(`fatigue-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [data, focus]);

  const c = data?.counts;
  return (
    <div className="page stack">
      <div className="page-head row-between wrap" style={{ marginBottom: 0, gap: 12 }}>
        <div>
          <div className="eyebrow">Workforce</div>
          <h1>Rest &amp; fatigue</h1>
          <p className="lead">
            At least {RULES.minRestHours} hours off between shifts, no more than {RULES.maxHoursPer24} hours of work in any 24, and no more than{' '}
            {RULES.maxConsecutiveDays} days in a row. Shifts are counted as worked, so time held over at a handover counts. A supervisor can still
            roster a shift that breaks a rule, with a warning; an officer cannot claim or swap into one.
          </p>
        </div>
        <Segmented
          label="Look ahead"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: 'Week' },
            { value: 14, label: '2 weeks' },
            { value: 28, label: '4 weeks' },
          ]}
        />
      </div>

      {!data ? (
        <LoadingPage label="Loading rest and fatigue" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Short rest" value={c.short_rest} foot={`Under ${RULES.minRestHours} h off before the shift`} alert={c.short_rest > 0} />
            <Stat label="Long days" value={c.long_day} foot={`Over ${RULES.maxHoursPer24} h of work in 24 h`} alert={c.long_day > 0} />
            <Stat label="Too many days" value={c.too_many_days} foot={`Over ${RULES.maxConsecutiveDays} days in a row`} alert={c.too_many_days > 0} />
            <Stat label="In the next day" value={c.soon} foot="Also in the alerts inbox" alert={c.soon > 0} />
          </div>
          <section className="card" aria-labelledby="fatigue-list">
            <div className="card-head">
              <h2 id="fatigue-list" className="section-title" style={{ margin: 0 }}>Next {s(data.days, 'day')}</h2>
              <span className="small muted">{s(c.total, 'shift')}</span>
            </div>
            {data.shifts.length === 0 ? (
              <Empty icon="clock" title="Everybody gets their rest">No shift in this window breaks a rest or fatigue rule.</Empty>
            ) : (
              <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.shifts.map((f) => (
                  <li key={f.shift_id} id={`fatigue-${f.shift_id}`} className={`list-item handover${f.shift_id === focus ? ' is-focused' : ''}`}
                    style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <div className="grow stack-sm">
                      <div className="row wrap" style={{ gap: 8 }}>
                        {f.issues.map((i) => (
                          <Chip key={i.code} kind={i.code === 'short_rest' && f.hours_away <= 24 ? 'danger' : 'warn'}>{i.label}</Chip>
                        ))}
                        <Link className="small strong" to={`/admin/employees/${f.user_id}`}>{f.officer}</Link>
                      </div>
                      <div className="small">
                        {fmtDay(f.starts_at)}, {fmtRange(f.starts_at, f.ends_at)} · {f.post_name}, <span className="muted">{f.site_name}</span>
                      </div>
                      {f.issues.map((i) => (
                        <div key={i.code} className="tiny muted">{i.message}</div>
                      ))}
                      {f.previous && (
                        <div className="tiny muted">
                          Last shift ended {fmtDay(f.previous.ends_at)} {fmtTime(f.previous.ends_at)}
                          {f.previous.held_over ? ', held over past its scheduled end' : ''}.
                        </div>
                      )}
                    </div>
                    <Link className="btn btn-ghost btn-sm" to={`/admin/schedule?week=${weekOf(f.starts_at)}&shift=${f.shift_id}`}
                      aria-label={`Open ${f.officer}'s shift on the schedule`}>
                      Open on the schedule
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
