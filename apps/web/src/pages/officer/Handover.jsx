import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtTime } from '../../lib/format.js';
import { Icon } from '../../components/ui.jsx';

const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`);

/** What the officer going off post should know about who takes over. */
function outgoingText(h) {
  const r = h.relief;
  switch (h.state) {
    case 'late':
      return {
        kind: 'danger',
        title: 'Your relief is late',
        body: `${r.officer} was due at ${fmtTime(r.starts_at)}. Stay on post until they arrive: the extra time is paid, and the office is chasing them.`,
      };
    case 'open':
      return {
        kind: 'danger',
        title: 'Nobody is booked to relieve you yet',
        body: h.held_over_minutes
          ? 'The office knows and is finding cover. Stay on post until someone arrives; the extra time is paid.'
          : `The office knows and is finding cover before ${fmtTime(h.ends_at)}. Do not leave the post uncovered.`,
      };
    case 'relieved':
      return { kind: 'ok', title: `${r.officer} is on post`, body: 'Hand over, leave a pass-down note if anything is outstanding, and clock out.' };
    case 'confirmed':
    case 'unconfirmed':
      return {
        kind: 'info',
        title: `${r.officer} relieves you at ${fmtTime(r.starts_at)}`,
        body: h.state === 'confirmed' ? 'They have confirmed they will be there.' : 'They have not confirmed yet. If they are not here on time, stay on post and call the office.',
      };
    default:
      return null;
  }
}

/** On the home screen: who relieves the officer at the end of their shift, and whose post they take over next. */
export function HandoverCard() {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get('/handovers/mine').then(setData, () => setData(null));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return null;
  const out = data.outgoing && outgoingText(data.outgoing);
  const inc = data.incoming;
  if (!out && !inc) return null;
  return (
    <div className="card" id="handover">
      <div className="card-head">
        <h3>
          <Icon name="route" size={18} /> Handover
        </h3>
      </div>
      <div className="card-body stack-sm">
        {out && (
          <div className={`banner banner-${out.kind}`} role={out.kind === 'danger' ? 'alert' : undefined}>
            <Icon name={out.kind === 'ok' ? 'check' : 'alert'} size={18} />
            <div className="grow">
              <strong>{out.title}</strong>
              <div className="small">{out.body}</div>
            </div>
          </div>
        )}
        {inc && (
          <div className={`banner banner-${inc.state === 'late' ? 'danger' : 'info'}`}>
            <Icon name="clock" size={18} />
            <div className="grow">
              <strong>
                You relieve {inc.officer} at {fmtTime(inc.relief.starts_at)}
              </strong>
              <div className="small">
                {inc.post_name}, {inc.site_name}.{' '}
                {inc.state === 'late'
                  ? `You are ${mins(inc.relief.minutes_late)} late and ${inc.officer} is waiting to hand over. If you cannot make it, call the office now.`
                  : 'Get the pass-down from them before they go.'}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
