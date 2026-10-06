import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDate, fmtDay, fmtRange } from './format.js';
import { Card, Chip } from './ui.jsx';
import { C, S } from './theme.js';

const STATE = {
  trained: ['ok', 'Trained'],
  lapsed: ['warn', 'Needs a refresher'],
  revoked: ['danger', 'Withdrawn'],
};

/**
 * The posts that need site training which this officer is cleared for, and
 * any training shifts coming up - shifts at a post they are not signed off at
 * yet, worked alongside a trained officer.
 */
export function SiteTraining({ refreshKey }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get('/site-training/mine').then(setData, () => setData(null));
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (!data || (!data.posts.length && !data.training_shifts.length)) return null;
  return (
    <Card title="Site training">
      {data.training_shifts.map((t) => (
        <View key={t.shift_id} style={{ padding: 14, gap: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={[S.row, S.wrap, { gap: 6 }]}>
            <Chip tone="warn">Training shift</Chip>
            <Text style={[S.small, S.strong]}>{t.post_name}</Text>
          </View>
          <Text style={S.tiny}>{`${t.site_name} · ${fmtDay(t.starts_at)}, ${fmtRange(t.starts_at, t.ends_at)}`}</Text>
          <Text style={S.tiny}>Work it with a trained officer. A supervisor signs you off afterwards.</Text>
        </View>
      ))}
      {data.posts.map((p, i) => {
        const [tone, label] = STATE[p.state] || ['plain', p.state];
        return (
          <View key={p.id} style={{ padding: 14, gap: 4, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
            <View style={[S.row, S.wrap, { gap: 6 }]}>
              <Text style={[S.small, S.strong]}>{p.post_name}</Text>
              <Chip tone={tone}>{label}</Chip>
            </View>
            <Text style={S.tiny}>
              {p.state === 'revoked'
                ? `${p.site_name} · withdrawn ${fmtDate(p.revoked_at)}: ${p.revoke_reason}`
                : `${p.site_name} · ${p.method_label}, ${fmtDate(p.trained_at)}${p.signed_off_by_name ? ` · ${p.signed_off_by_name}` : ''}`}
            </Text>
          </View>
        );
      })}
    </Card>
  );
}
