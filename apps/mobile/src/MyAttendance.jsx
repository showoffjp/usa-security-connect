import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDateShort, fmtTime } from './format.js';
import { Card, Chip } from './ui.jsx';
import { C, S } from './theme.js';

const hrs = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${h} h`);

function Figure({ label, value, foot, bad }) {
  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderColor: bad ? C.danger : C.line, borderRadius: 10, padding: 10 }}>
      <Text style={[S.label, { marginBottom: 2 }]}>{label}</Text>
      <Text style={{ fontSize: 20, fontWeight: '800', color: bad ? C.danger : C.ink }}>{value}</Text>
      <Text style={[S.tiny, S.muted]}>{foot}</Text>
    </View>
  );
}

/**
 * The officer's own attendance over the last 90 days: on time, late,
 * no-shows and call-offs - the same record their supervisors see, and the
 * same as the web app's.
 */
export function MyAttendance({ refreshKey }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/heads-up/record?days=90').then(setData, () => setData(null));
  }, [refreshKey]);
  if (!data || !data.summary.due) return null;
  const s = data.summary;
  const items = data.items.slice(0, 5);
  return (
    <Card title="My attendance" right={<Text style={[S.tiny, S.muted]}>Last {data.days} days</Text>}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Figure
          label="On time"
          value={s.onTimePct === null ? '--' : `${Math.round(s.onTimePct)}%`}
          foot={`${s.onTime} of ${s.worked} worked`}
          bad={s.onTimePct !== null && s.onTimePct < 90}
        />
        <Figure label="Late" value={s.late} foot={s.late ? `${s.avgLateMin} min on average` : 'None'} bad={s.late > 0} />
        <Figure label="No-shows" value={s.noShows} foot="Never clocked in" bad={s.noShows > 0} />
        <Figure
          label="Called off"
          value={s.calledOff}
          foot={s.shortNotice ? `${s.shortNotice} at short notice` : s.calledOff ? 'With notice' : 'None'}
          bad={s.calledOff > 1 || s.shortNotice > 0}
        />
      </View>
      {items.map((i, n) => (
        <View key={`${i.kind}-${i.shift_id}`} style={[S.listItem, n === items.length - 1 && { borderBottomWidth: 0 }]}>
          <View style={S.grow}>
            <Text style={[S.small, S.strong]}>
              {i.kind === 'late' ? `${i.minutes_late} min late` : i.kind === 'no_show' ? 'No-show' : `Called off: ${i.reason_label || 'no reason'}`}
            </Text>
            <Text style={S.tiny}>{`${fmtDateShort(i.starts_at)}, ${fmtTime(i.starts_at)} · ${i.post_name}`}</Text>
            {i.kind === 'called_off' && <Text style={[S.tiny, S.muted]}>{`${hrs(i.notice_hours)} before the start.${i.covered_by ? ` Covered by ${i.covered_by}.` : ''}`}</Text>}
          </View>
          {i.kind === 'called_off' && i.short_notice && <Chip tone="warn">Short notice</Chip>}
          {i.kind === 'late' && i.notice && <Chip tone="info">Told us</Chip>}
        </View>
      ))}
    </Card>
  );
}
