import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from './api.js';
import { fmtTime } from './format.js';
import { Banner, Card } from './ui.jsx';

const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`);

/** What the officer going off post should know about who takes over. */
function outgoingText(h) {
  const r = h.relief;
  switch (h.state) {
    case 'late':
      return {
        tone: 'danger',
        title: 'Your relief is late',
        body: `${r.officer} was due at ${fmtTime(r.starts_at)}. Stay on post until they arrive: the extra time is paid, and the office is chasing them.`,
      };
    case 'open':
      return {
        tone: 'danger',
        title: 'Nobody is booked to relieve you yet',
        body: h.held_over_minutes
          ? 'The office knows and is finding cover. Stay on post until someone arrives; the extra time is paid.'
          : `The office knows and is finding cover before ${fmtTime(h.ends_at)}. Do not leave the post uncovered.`,
      };
    case 'relieved':
      return { tone: 'ok', title: `${r.officer} is on post`, body: 'Hand over, leave a pass-down note if anything is outstanding, and clock out.' };
    case 'confirmed':
    case 'unconfirmed':
      return {
        tone: 'info',
        title: `${r.officer} relieves you at ${fmtTime(r.starts_at)}`,
        body: h.state === 'confirmed' ? 'They have confirmed they will be there.' : 'They have not confirmed yet. If they are not here on time, stay on post and call the office.',
      };
    default:
      return null;
  }
}

/** On the home screen: who relieves the officer at the end of their shift, and whose post they take over next. */
export function HandoverCard({ refreshKey }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get('/handovers/mine').then(setData, () => setData(null));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, refreshKey]);
  if (!data) return null;
  const out = data.outgoing && outgoingText(data.outgoing);
  const inc = data.incoming;
  if (!out && !inc) return null;
  return (
    <Card title="Handover">
      <View style={{ gap: 10 }}>
        {out && (
          <Banner tone={out.tone} title={out.title}>
            {out.body}
          </Banner>
        )}
        {inc && (
          <Banner tone={inc.state === 'late' ? 'danger' : 'info'} title={`You relieve ${inc.officer} at ${fmtTime(inc.relief.starts_at)}`}>
            {`${inc.post_name}, ${inc.site_name}. ${
              inc.state === 'late'
                ? `You are ${mins(inc.relief.minutes_late)} late and ${inc.officer} is waiting to hand over. If you cannot make it, call the office now.`
                : 'Get the pass-down from them before they go.'
            }`}
          </Banner>
        )}
      </View>
    </Card>
  );
}
