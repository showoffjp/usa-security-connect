import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDateShort, fmtTime } from '../lib/format.js';
import { Chip, Empty, Icon, Segmented } from './ui.jsx';

const PERIODS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
];
const hrs = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${h} h`);

function Item({ i, self }) {
  const when = `${fmtDateShort(i.starts_at)}, ${fmtTime(i.starts_at)}`;
  const where = `${i.post_name}, ${i.site_name}`;
  const icon = i.kind === 'late' ? 'clock' : i.kind === 'no_show' ? 'alert' : 'x';
  const tone = i.kind === 'late' ? 'warn' : 'danger';
  return (
    <div className="list-item" style={{ cursor: 'default' }}>
      <div className="lead-icon" style={{ background: `var(--${tone}-bg)`, color: `var(--${tone})` }}>
        <Icon name={icon} size={17} />
      </div>
      <div className="grow">
        <div className="small strong">
          {i.kind === 'late' && `${i.minutes_late} min late`}
          {i.kind === 'no_show' && 'No-show'}
          {i.kind === 'called_off' && `Called off: ${i.reason_label || 'no reason given'}`}
        </div>
        <div className="tiny muted">
          {when} · {where}
        </div>
        <div className="tiny muted">
          {i.kind === 'late' && `Clocked in ${fmtTime(i.clock_in_at)}.`}
          {i.kind === 'called_off' && `${hrs(i.notice_hours)} before the start.`}
          {i.notice && ` ${self ? 'You' : 'They'} said ${fmtTime(i.notice.eta_at)}${i.kept_word === true ? ' and made it' : i.kept_word === false ? ', and were later' : ''}.`}
          {i.covered_by && ` Covered by ${i.covered_by}.`}
        </div>
        {i.note && <div className="tiny muted">"{i.note}"</div>}
      </div>
      {i.kind === 'called_off' && i.short_notice && <Chip kind="warn">Short notice</Chip>}
      {i.kind === 'late' && i.notice && <Chip kind="info">Told us</Chip>}
    </div>
  );
}

/**
 * Attendance over a period: shifts worked and on time, late arrivals,
 * no-shows and call-offs, with the shifts behind each. On an employee's
 * record for supervisors (`userId`), and on an officer's own profile, where
 * it reads in the second person.
 */
export default function AttendanceRecord({ userId = null, name = '' }) {
  const self = !userId;
  const [days, setDays] = useState('90');
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get(self ? `/heads-up/record?days=${days}` : `/attendance/record/${userId}?days=${days}`).then(
      (d) => alive && setData(d),
      () => alive && setData(null)
    );
    return () => {
      alive = false;
    };
  }, [userId, days, self]);
  if (!data) return null;
  const s = data.summary;
  const figures = [
    {
      label: 'On time',
      value: s.onTimePct === null ? '--' : `${Math.round(s.onTimePct)}%`,
      foot: `${s.onTime} of ${s.worked} worked`,
      bad: s.onTimePct !== null && s.onTimePct < 90,
    },
    { label: 'Late', value: s.late, foot: s.late ? `${s.avgLateMin} min on average` : `None past ${data.rules.lateGraceMinutes} min`, bad: s.late > 0 },
    { label: 'No-shows', value: s.noShows, foot: 'Never clocked in', bad: s.noShows > 0 },
    {
      label: 'Called off',
      value: s.calledOff,
      foot: s.shortNotice ? `${s.shortNotice} at short notice` : s.calledOff ? 'With notice' : 'None',
      bad: s.calledOff > 1 || s.shortNotice > 0,
    },
  ];
  return (
    <div className="card" id={self ? 'my-attendance' : 'attendance-record'}>
      <div className="card-head wrap" style={{ gap: 8 }}>
        <h3>{self ? 'My attendance' : 'Attendance'}</h3>
        <Segmented label="Attendance period" value={days} onChange={setDays} options={PERIODS} />
      </div>
      <div className="tally">
        {figures.map((f) => (
          <div key={f.label} className={f.bad ? 'bad' : ''}>
            <div className="l">{f.label}</div>
            <div className="n">{f.value}</div>
            <div className="f">{f.foot}</div>
          </div>
        ))}
      </div>
      <div className="card-pad tiny muted" style={{ paddingTop: 8, paddingBottom: 0 }}>
        {s.worked} of {s.due} shift{s.due === 1 ? '' : 's'} worked in the last {data.days} days.
        {s.headsUps > 0 &&
          ` ${self ? 'You' : 'They'} warned the supervisors ${s.headsUps === 1 ? 'once' : `${s.headsUps} times`} that ${self ? 'you' : 'they'} would be late, and got there by the time given ${s.keptWord} of ${s.headsUps}.`}
        {data.byReason.length > 0 && ` Call-offs: ${data.byReason.map((r) => `${r.label.toLowerCase()} ${r.count}`).join(', ')}.`}
        {` A call-off with under ${data.rules.shortNoticeHours} hours to go is short notice.`}
      </div>
      {data.items.length === 0 ? (
        <Empty icon="check" title={s.due ? 'On time for every shift' : 'No shifts in this period'}>
          {s.due ? `${self ? 'You' : name || 'They'} clocked in on time for every shift in the last ${data.days} days.` : null}
        </Empty>
      ) : (
        <div className="list" style={{ marginTop: 8 }}>
          {data.items.map((i) => (
            <Item key={`${i.kind}-${i.shift_id}`} i={i} self={self} />
          ))}
        </div>
      )}
    </div>
  );
}
