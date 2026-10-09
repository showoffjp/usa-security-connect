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

const POINT_WORDS = { late: 'late start', no_show: 'no-show', called_off: 'call-off' };
const fmtShort = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** What the coaching record is about, written out from the lapses that scored. */
export function pointsSummary(data) {
  const st = data.standing;
  const byKey = new Map(data.items.map((i) => [`${i.kind}-${i.shift_id}`, i]));
  const lines = st.items.map((p) => {
    const i = byKey.get(`${p.kind}-${p.shift_id}`) || p;
    if (p.kind === 'late') return `late ${i.minutes_late ?? ''} min on ${fmtShort(p.starts_at)}`.replace('  ', ' ');
    if (p.kind === 'no_show') return `no-show on ${fmtShort(p.starts_at)} at ${p.post_name}`;
    return `called off${i.reason_label ? ` (${i.reason_label.toLowerCase()})` : ''} on ${fmtShort(p.starts_at)}${i.short_notice ? ', at short notice' : ''}`;
  });
  return `${st.points} attendance points in the last ${st.windowDays} days, over the limit of ${st.threshold}: ${lines.join('; ')}.`;
}

/** Points in the last 30 days against the limit, and what to do about them. */
function Points({ data, self, name, onRecordStep }) {
  const st = data.standing;
  const rules = data.rules.points;
  if (!st) return null;
  const pct = Math.min(100, Math.round((st.points / st.threshold) * 100));
  const how = `A no-show is ${rules.noShow} points, a call-off ${rules.callOff} (${rules.shortCallOff} at short notice) and a late start ${rules.late}, or none if ${self ? 'you' : 'they'} warned the supervisors and got there by the time given.`;
  const tally = Object.entries(POINT_WORDS)
    .map(([k, w]) => [st.items.filter((i) => i.kind === k).reduce((a, i) => a + i.points, 0), w, st.items.filter((i) => i.kind === k).length])
    .filter(([pts]) => pts)
    .map(([pts, w, n]) => `${n} ${w}${n === 1 ? '' : 's'} (${pts})`)
    .join(', ');
  if (st.needs_review && !self) {
    return (
      <div className="banner banner-warn" style={{ margin: '14px 18px 0' }} id="attendance-points">
        <Icon name="alert" size={18} />
        <div className="grow">
          <strong>Over the attendance limit: {st.points} points in {st.windowDays} days</strong>
          <div className="small">
            {tally}. The limit is {st.threshold}. Talk to {name || 'them'} and record what was said: it clears this from the alerts.
          </div>
        </div>
        {onRecordStep && (
          <button className="btn btn-primary btn-sm" onClick={() => onRecordStep({ category: 'attendance', summary: pointsSummary(data) })}>
            Record a step
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="card-pad" style={{ paddingBottom: 0 }} id="attendance-points">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <span className="small">
          <strong>{self ? 'Your attendance points' : 'Attendance points'}: {st.points}</strong>
          <span className="muted"> of {st.threshold} in the last {st.windowDays} days</span>
        </span>
        {st.reviewed ? (
          <Chip kind="info">{st.reviewed.level_label} recorded {fmtShort(st.reviewed.created_at)}</Chip>
        ) : st.over ? (
          <Chip kind="danger">Over the limit</Chip>
        ) : null}
      </div>
      <div className="progress" role="meter" aria-label="Attendance points" aria-valuemin={0} aria-valuemax={st.threshold} aria-valuenow={st.points} style={{ marginTop: 6 }}>
        <span style={{ width: `${pct}%`, background: st.over ? 'var(--danger)' : st.points ? 'var(--warn)' : 'var(--ok)' }} />
      </div>
      <div className="tiny muted" style={{ marginTop: 6 }}>
        {tally ? `${tally}. ` : ''}
        {how}
        {self && st.over && !st.reviewed && ' Over the limit, your supervisor will talk to you about it.'}
      </div>
    </div>
  );
}

function Item({ i, self, points }) {
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
      <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
        {i.kind === 'called_off' && i.short_notice && <Chip kind="warn">Short notice</Chip>}
        {i.kind === 'late' && i.notice && <Chip kind="info">Told us</Chip>}
        {points > 0 && <span className="tiny muted nowrap">{points} point{points === 1 ? '' : 's'}</span>}
      </div>
    </div>
  );
}

/**
 * Attendance over a period: shifts worked and on time, late arrivals,
 * no-shows and call-offs, with the shifts behind each, and the attendance
 * points of the last 30 days against the limit. On an employee's record for
 * supervisors (`userId`, with Record a step when over the limit), and on an
 * officer's own profile, where it reads in the second person.
 */
export default function AttendanceRecord({ userId = null, name = '', onRecordStep = null, refreshKey = 0 }) {
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
  }, [userId, days, self, refreshKey]);
  // Opened from an alert (…#attendance-record): bring the card into view once it has loaded.
  const loaded = Boolean(data);
  useEffect(() => {
    const id = self ? 'my-attendance' : 'attendance-record';
    if (loaded && window.location.hash === `#${id}`) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [loaded, self]);
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
      <Points data={data} self={self} name={name} onRecordStep={onRecordStep} />
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
            <Item
              key={`${i.kind}-${i.shift_id}`}
              i={i}
              self={self}
              points={data.standing?.items.find((p) => p.kind === i.kind && p.shift_id === i.shift_id)?.points || 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
