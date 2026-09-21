import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View, Pressable } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { api } from '../../src/api.js';
import { fmtDateTime, fmtRelative } from '../../src/format.js';
import { Card, Chip, StatusChip, Button, Empty, Loading, Toast, useToastState } from '../../src/ui.jsx';
import { C, S } from '../../src/theme.js';

export default function ToursScreen() {
  const router = useRouter();
  const [toast, setToast] = useToastState();
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [starting, setStarting] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [tours, runs] = await Promise.all([api.get('/tours'), api.get('/tours/runs?limit=8')]);
      setData(tours);
      setHistory(runs.runs);
    } catch (err) {
      setToast({ message: err.message, tone: 'err' });
      setData({ tours: [], activeRun: null });
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Refresh whenever the tab regains focus, so finishing a tour is reflected.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const start = async (tour) => {
    setStarting(tour.id);
    try {
      const run = await api.post(`/tours/${tour.id}/start`);
      router.push(`/tour/${run.run.id}`);
    } catch (err) {
      if (err.status === 409 && err.details?.activeRunId) {
        router.push(`/tour/${err.details.activeRunId}`);
        return;
      }
      setToast({ message: err.message, tone: 'err' });
    } finally {
      setStarting(null);
    }
  };

  if (!data) return <Loading label="Loading tours" />;

  return (
    <View style={S.screen}>
      <ScrollView
        contentContainerStyle={S.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.brand600} />
        }
      >
        <View>
          <Text style={S.eyebrow}>Patrol</Text>
          <Text style={S.h1}>Tours &amp; tasks</Text>
          <Text style={[S.small, S.muted, { marginTop: 4 }]}>
            Walk the route, scan each checkpoint, tick off the tasks.
          </Text>
        </View>

        {!!data.activeRun && (
          <Pressable style={[S.card, { borderColor: C.brand400 }]} onPress={() => router.push(`/tour/${data.activeRun.id}`)}>
            <View style={[S.cardPad, S.rowBetween]}>
              <View style={S.grow}>
                <Text style={[S.small, S.strong]}>{data.activeRun.tour_name} is in progress</Text>
                <Text style={S.tiny}>Started {fmtRelative(data.activeRun.started_at)}</Text>
              </View>
              <Chip tone="brand">Continue</Chip>
            </View>
          </Pressable>
        )}

        <Card title="Available tours">
          {data.tours.length === 0 ? (
            <Empty title="No tours at this site">
              Tours are set up per site. Clock in at a post to see its routes.
            </Empty>
          ) : (
            data.tours.map((t, i) => (
              <View key={t.id} style={[S.listItem, i === data.tours.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={S.grow}>
                  <Text style={[S.small, S.strong]}>{t.name}</Text>
                  <Text style={S.tiny}>{t.description}</Text>
                  <View style={[S.row, { marginTop: 5 }]}>
                    <Chip tone="navy">{t.checkpoint_count} checkpoints</Chip>
                    {!!t.expected_minutes && <Chip>~{t.expected_minutes} min</Chip>}
                  </View>
                </View>
                <Button
                  title={starting === t.id ? '...' : 'Start'}
                  variant="primary"
                  disabled={!!data.activeRun}
                  busy={starting === t.id}
                  onPress={() => start(t)}
                  style={{ paddingVertical: 9, paddingHorizontal: 14 }}
                />
              </View>
            ))
          )}
        </Card>

        {history.length > 0 && (
          <Card title="Recent walks">
            {history.map((r, i) => (
              <View key={r.id} style={[S.listItem, i === history.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={S.grow}>
                  <Text style={[S.small, S.strong]}>{r.tour_name}</Text>
                  <Text style={S.tiny}>{fmtDateTime(r.started_at)}</Text>
                </View>
                <Text style={S.tiny}>
                  {r.done}/{r.total}
                </Text>
                <StatusChip value={r.status} />
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
      <Toast toast={toast} />
    </View>
  );
}
