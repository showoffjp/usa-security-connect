import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { api } from '../../src/api.js';
import { fmtDay, fmtRange, fmtTime, fmtDate } from '../../src/format.js';
import {
  Card, Chip, StatusChip, Empty, Loading, Segmented, Toast, useToastState,
} from '../../src/ui.jsx';
import { OpenShifts, MyShiftRequests, ShiftActionSheet } from '../../src/ShiftActions.jsx';
import { C, S } from '../../src/theme.js';
import { toHours, formatDuration } from '../../src/shared.js';

export default function ScheduleScreen() {
  const [toast, setToast] = useToastState();
  const [shifts, setShifts] = useState(null);
  const [hours, setHours] = useState(null);
  const [view, setView] = useState('upcoming');
  const [refreshing, setRefreshing] = useState(false);
  const [actioning, setActioning] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api.get('/schedule'), api.get('/schedule/hours')]);
      setShifts(s.shifts);
      setHours(h);
    } catch (err) {
      setToast({ message: err.message, tone: 'err' });
      setShifts([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (!shifts || !hours) return <Loading label="Loading your schedule" />;

  const now = Date.now();
  const list =
    view === 'open'
      ? []
      : shifts.filter((s) =>
          view === 'upcoming' ? new Date(s.ends_at).getTime() >= now : new Date(s.ends_at).getTime() < now
        );
  if (view === 'past') list.reverse();

  // Group by calendar day so it reads like a roster.
  const groups = [];
  for (const s of list) {
    const key = new Date(s.starts_at).toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(s);
    else groups.push({ key, items: [s] });
  }

  return (
    <View style={S.screen}>
      <ScrollView
        contentContainerStyle={S.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.brand600} />
        }
      >
        <View>
          <Text style={S.eyebrow}>Roster</Text>
          <Text style={S.h1}>My schedule</Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Card style={S.grow}>
            <View style={S.cardPad}>
              <Text style={[S.tiny, { fontWeight: '800', letterSpacing: 0.6 }]}>THIS WEEK</Text>
              <Text style={{ fontSize: 24, fontWeight: '800', color: C.ink }}>{hours.thisWeek.hours}</Text>
              <Text style={S.tiny}>
                {hours.thisWeek.shifts} shifts
                {hours.thisWeek.overtimeHours > 0 ? ` · ${hours.thisWeek.overtimeHours}h OT` : ''}
              </Text>
            </View>
          </Card>
          <Card style={S.grow}>
            <View style={S.cardPad}>
              <Text style={[S.tiny, { fontWeight: '800', letterSpacing: 0.6 }]}>OPEN FLAGS</Text>
              <Text style={{ fontSize: 24, fontWeight: '800', color: hours.openFlags ? C.warn : C.ink }}>
                {hours.openFlags}
              </Text>
              <Text style={S.tiny}>{hours.openFlags ? 'Under review' : 'All clear'}</Text>
            </View>
          </Card>
        </View>

        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'open', label: 'Open' },
            { value: 'past', label: 'Worked' },
          ]}
        />

        {view === 'open' ? (
          <>
            <OpenShifts notify={(message, tone) => setToast({ message, tone })} onChanged={load} />
            <MyShiftRequests notify={(message, tone) => setToast({ message, tone })} onChanged={load} />
          </>
        ) : groups.length === 0 ? (
          <Card>
            <Empty title={view === 'upcoming' ? 'No upcoming shifts' : 'No shifts worked yet'}>
              {view === 'upcoming' ? 'Assigned posts appear here.' : 'Completed shifts appear here.'}
            </Empty>
          </Card>
        ) : (
          groups.map((g) => (
            <Card
              key={g.key}
              title={fmtDay(g.items[0].starts_at)}
              right={<Text style={S.tiny}>{fmtDate(g.items[0].starts_at)}</Text>}
            >
              {g.items.map((s, i) => {
                const worked = s.clock_in_at && s.clock_out_at;
                // Only a future, unworked shift can be swapped or dropped.
                const changeable =
                  view === 'upcoming' && !s.clock_in_at && new Date(s.starts_at).getTime() > now;

                return (
                  <Pressable
                    key={s.id}
                    disabled={!changeable}
                    onPress={() => setActioning(s)}
                    style={({ pressed }) => [
                      S.listItem,
                      i === g.items.length - 1 && { borderBottomWidth: 0 },
                      pressed && { backgroundColor: C.surface2 },
                    ]}
                  >
                    <View style={S.grow}>
                      <Text style={[S.small, S.strong]}>{s.post_name}</Text>
                      <Text style={S.tiny}>{s.site_name}</Text>
                      <Text style={[S.tiny, { marginTop: 2 }]}>
                        {worked
                          ? `In ${fmtTime(s.clock_in_at)} · Out ${fmtTime(s.clock_out_at)}`
                          : `${formatDuration(
                              Math.round((new Date(s.ends_at) - new Date(s.starts_at)) / 60000)
                            )} scheduled`}
                        {changeable ? '  ·  tap for options' : ''}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <Text style={[S.small, S.strong]}>{fmtRange(s.starts_at, s.ends_at)}</Text>
                      {s.late_minutes > 0 && <Chip tone="warn">{s.late_minutes}m late</Chip>}
                      {worked ? <Chip tone="ok">{toHours(s.minutes_worked)}h</Chip> : <StatusChip value={s.status} />}
                    </View>
                  </Pressable>
                );
              })}
            </Card>
          ))
        )}
      </ScrollView>

      {!!actioning && (
        <ShiftActionSheet
          shift={actioning}
          onClose={() => setActioning(null)}
          notify={(message, tone) => setToast({ message, tone })}
          onChanged={load}
        />
      )}

      <Toast toast={toast} />
    </View>
  );
}
