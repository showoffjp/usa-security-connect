import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api.js';
import { fmtRelative } from './format.js';
import { VISIT_CHECKS } from './shared.js';
import { Card, Chip } from './ui.jsx';
import { C, S } from './theme.js';

/**
 * The officer's latest supervisor visit, for a week after it. The client
 * reads only the supervisor's note for them, never this.
 */
export function LastVisitCard() {
  const [visit, setVisit] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/visits?days=7&limit=1').then(
      (d) => alive && setVisit(d.visits?.[0] || null),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!visit) return null;
  const checks = VISIT_CHECKS.filter((c) => visit[c.key] != null);
  return (
    <Card
      title="Your last supervisor visit"
      right={visit.rating != null ? <Chip tone={visit.rating <= 2 ? 'danger' : visit.rating >= 4 ? 'ok' : 'plain'}>{`${visit.rating} of 5`}</Chip> : null}
    >
      <View style={[S.cardPad, { gap: 6 }]}>
        <Text style={S.tiny}>
          {visit.supervisor_name} · {fmtRelative(visit.visited_at)}
          {visit.post_name ? ` · ${visit.post_name}` : ''}
        </Text>
        {checks.map((c) => (
          <Text key={c.key} style={[S.small, { color: visit[c.key] ? C.ok : C.danger, fontWeight: visit[c.key] ? '400' : '700' }]}>
            {visit[c.key] ? '✓' : '✗'} {c.label}
          </Text>
        ))}
        {!!visit.notes && <Text style={[S.small, { lineHeight: 20 }]}>{visit.notes}</Text>}
      </View>
    </Card>
  );
}
