import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDay, fmtRange, fmtTime, fmtDate } from '../../lib/format.js';
import { LoadingPage, Empty, Chip, StatusChip, Icon, Segmented, useToast } from '../../components/ui.jsx';
import { formatDuration, toHours } from '@shared/domain.js';
import RecentPunches from './RecentPunches.jsx';

export default function SchedulePage() {
  const toast = useToast();
  const [shifts, setShifts] = useState(null);
  const [hours, setHours] = useState(null);
  const [view, setView] = useState('upcoming');

  useEffect(() => {
    (async () => {
      try {
        const [s, h] = await Promise.all([api.get('/schedule'), api.get('/schedule/hours')]);
        setShifts(s.shifts);
        setHours(h);
      } catch (err) {
        toast.error(err.message);
        setShifts([]);
      }
    })();
  }, [toast]);

  const groups = useMemo(() => {
    if (!shifts) return [];
    const now = Date.now();
    const filtered = shifts.filter((s) =>
      view === 'upcoming' ? new Date(s.ends_at).getTime() >= now : new Date(s.ends_at).getTime() < now
    );
    if (view === 'past') filtered.reverse();

    // Group by calendar day so the list reads like a roster.
    const byDay = new Map();
    for (const s of filtered) {
      const key = new Date(s.starts_at).toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(s);
    }
    return [...byDay.entries()];
  }, [shifts, view]);

  if (!shifts || !hours) return <LoadingPage label="Loading your schedule" />;

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">Roster</div>
        <h1>My schedule</h1>
        <p className="lead">Shifts assigned to you, and the hours already recorded.</p>
      </div>

      <div className="grid grid-3">
        <div className="stat">
          <div className="label">This week</div>
          <div className="value">{hours.thisWeek.hours}</div>
          <div className="foot">
            {hours.thisWeek.shifts} shift{hours.thisWeek.shifts === 1 ? '' : 's'}
            {hours.thisWeek.overtimeHours > 0 && ` - ${hours.thisWeek.overtimeHours}h OT`}
          </div>
        </div>
        <div className="stat">
          <div className="label">Last week</div>
          <div className="value">{hours.lastWeek.hours}</div>
          <div className="foot">{hours.lastWeek.shifts} shifts</div>
        </div>
        <div className="stat" style={hours.openFlags > 0 ? { borderColor: '#f0d7ae' } : undefined}>
          <div className="label">Open flags</div>
          <div className="value">{hours.openFlags}</div>
          <div className="foot">{hours.openFlags ? 'Your supervisor will follow up' : 'All clear'}</div>
        </div>
      </div>

      <Segmented
          label="Schedule view"
        value={view}
        onChange={setView}
        options={[
          { value: 'upcoming', label: 'Upcoming' },
          { value: 'past', label: 'Worked' },
        ]}
      />

      {view === 'past' && <RecentPunches />}

      {groups.length === 0 ? (
        <div className="card">
          <Empty icon="calendar" title={view === 'upcoming' ? 'No upcoming shifts' : 'No shifts worked yet'}>
            {view === 'upcoming'
              ? 'When dispatch assigns you a post it will appear here.'
              : 'Completed shifts appear here with the hours recorded.'}
          </Empty>
        </div>
      ) : (
        <div className="stack">
          {groups.map(([day, list]) => (
            <div key={day} className="card">
              <div className="card-head">
                <h3>{fmtDay(list[0].starts_at)}</h3>
                <span className="small muted">{fmtDate(list[0].starts_at)}</span>
              </div>
              <div className="list">
                {list.map((s) => {
                  const worked = s.clock_in_at && s.clock_out_at;
                  return (
                    <div key={s.id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="lead-icon">
                        <Icon name="shield" size={18} />
                      </div>
                      <div className="grow">
                        <div className="strong small">{s.post_name}</div>
                        <div className="tiny muted">
                          {s.site_name}
                          {s.address ? ` - ${s.city}, ${s.state}` : ''}
                        </div>
                        {s.instructions && view === 'upcoming' && (
                          <details className="tiny" style={{ marginTop: 4 }}>
                            <summary style={{ cursor: 'pointer', color: 'var(--navy-700)' }}>Post orders</summary>
                            <div style={{ whiteSpace: 'pre-line', marginTop: 4, color: 'var(--ink-3)' }}>
                              {s.instructions}
                            </div>
                          </details>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="small strong nowrap">{fmtRange(s.starts_at, s.ends_at)}</div>
                        <div className="tiny muted">
                          {worked ? (
                            <>
                              In {fmtTime(s.clock_in_at)} &middot; Out {fmtTime(s.clock_out_at)}
                            </>
                          ) : (
                            formatDuration(
                              Math.round((new Date(s.ends_at) - new Date(s.starts_at)) / 60000)
                            ) + ' scheduled'
                          )}
                        </div>
                        <div style={{ marginTop: 4 }} className="row wrap" >
                          {s.late_minutes > 0 && <Chip kind="warn">{s.late_minutes}m late</Chip>}
                          {worked ? (
                            <Chip kind="ok">{toHours(s.minutes_worked)}h</Chip>
                          ) : (
                            <StatusChip value={s.status} />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
