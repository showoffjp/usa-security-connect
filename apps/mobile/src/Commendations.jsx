import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDate } from './format.js';
import { Button, Card, Chip } from './ui.jsx';
import { C, S } from './theme.js';

/** Thanks from a client or a supervisor, on the home screen until read. */
export function NewCommendations({ notify, refreshKey }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get('/commendations/mine').then(setData, () => setData(null));
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (!data || !data.unseen) return null;
  const fresh = data.commendations.filter((c) => !c.seen).slice(0, 3);
  const done = async () => {
    try {
      await api.post('/commendations/mine/seen');
      load();
    } catch (err) {
      notify?.(err.message, 'err');
    }
  };

  return (
    <Card title="You were commended">
      {fresh.map((c, i) => (
        <View key={c.id} style={{ padding: 14, gap: 6, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <Chip tone="ok">{c.category_label}</Chip>
            <Text style={S.tiny}>{`${c.from}${c.site_name ? ` · ${c.site_name}` : ''} · ${fmtDate(c.created_at)}`}</Text>
          </View>
          <Text style={[S.small, { borderLeftWidth: 3, borderLeftColor: C.ok, paddingLeft: 10 }]}>{c.message}</Text>
        </View>
      ))}
      <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
        <Button variant="ghost" title="Thanks, got it" onPress={done} />
      </View>
    </Card>
  );
}
