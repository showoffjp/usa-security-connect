import { useCallback, useState } from 'react';
import { Linking, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { api } from '../src/api.js';
import { fmtDay, fmtTime } from '../src/format.js';
import { Banner, Button, Card, Chip, Empty, Loading, Toast, useToastState } from '../src/ui.jsx';
import { C, S } from '../src/theme.js';

const EVERY_SECONDS = 15;
const STATE = {
  no_show: ['danger', 'No-show'],
  late: ['warn', 'Late'],
  covering: ['info', 'Cover on the way'],
};
const STAGE_TONE = { late: 'warn', no_show: 'danger', arrived: 'ok', covered: 'ok' };
const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`);

/**
 * For supervisors on the move: who has not clocked in for a shift that has
 * started, refreshed every 15 seconds while open, with the officer a tap away.
 * A late or no-show notification opens here.
 */
export default function LateScreen() {
  const [toast, setToast] = useToastState();
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/attendance'));
    } catch (err) {
      setToast({ message: err.message, tone: 'err' });
    } finally {
      setRefreshing(false);
    }
  }, [setToast]);

  useFocusEffect(
    useCallback(() => {
      load();
      const t = setInterval(load, EVERY_SECONDS * 1000);
      return () => clearInterval(t);
    }, [load])
  );

  if (!data) return <Loading label="Loading late and no-shows" />;
  const me = data.settings;
  return (
    <View style={S.screen}>
      <ScrollView
        contentContainerStyle={S.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.brand600} />}
      >
        <View>
          <Text style={S.eyebrow}>Operations</Text>
          <Text style={S.h1}>Late & no-shows</Text>
          <Text style={[S.small, S.muted]}>
            Late after {data.rules.lateGraceMinutes} minutes, a no-show after {data.rules.noShowMinutes}. Updates every {EVERY_SECONDS} seconds.
          </Text>
        </View>

        <Banner tone="info" title={me.sms_enabled && me.phone_verified ? `Texts to ${me.phone}` : 'No texts'}>
          {me.push_enabled ? 'Notifications on this app. ' : ''}
          Change what you hear about under Late & no-shows → Text alerts in the admin console.
        </Banner>

        <Card title={`Right now (${data.open.length})`}>
          {data.open.length === 0 ? (
            <Empty title="Everyone due is on post">Every shift that has started has its officer clocked in.</Empty>
          ) : (
            data.open.map((o, i) => (
              <View key={o.shift_id} style={[S.listItem, i === data.open.length - 1 && { borderBottomWidth: 0 }, { alignItems: 'flex-start' }]}>
                <View style={[S.grow, { gap: 4 }]}>
                  <View style={[S.row, { flexWrap: 'wrap', gap: 6 }]}>
                    <Chip tone={STATE[o.state][0]}>{STATE[o.state][1]}</Chip>
                    <Text style={[S.small, S.strong]}>{o.officer}</Text>
                  </View>
                  <Text style={S.small}>{o.post_name}, {o.site_name}</Text>
                  <Text style={[S.tiny, S.muted]}>
                    Due {fmtTime(o.starts_at)} · {o.state === 'covering' ? `covering for ${o.covered_from}, not clocked in yet` : `not clocked in, ${mins(o.minutes_late)} after the start`}
                  </Text>
                </View>
                {o.phone ? (
                  <Button title="Call" variant="ghost" onPress={() => Linking.openURL(`tel:${String(o.phone).replace(/[^\d+]/g, '')}`)} />
                ) : null}
              </View>
            ))
          )}
        </Card>

        <Card title="Updates">
          {data.events.length === 0 ? (
            <Empty title="Nothing yet">Late starts and no-shows show here as they happen.</Empty>
          ) : (
            data.events.slice(0, 12).map((e, i) => (
              <View key={e.id} style={[S.listItem, i === Math.min(data.events.length, 12) - 1 && { borderBottomWidth: 0 }, { alignItems: 'flex-start' }]}>
                <View style={[S.grow, { gap: 4 }]}>
                  <View style={[S.row, { gap: 6 }]}>
                    <Chip tone={STAGE_TONE[e.stage]}>{e.label}</Chip>
                    <Text style={[S.tiny, S.muted]}>{fmtDay(e.occurred_at)}, {fmtTime(e.occurred_at)}</Text>
                  </View>
                  <Text style={S.small}>{e.line}</Text>
                </View>
              </View>
            ))
          )}
        </Card>
      </ScrollView>
      <Toast toast={toast} />
    </View>
  );
}
