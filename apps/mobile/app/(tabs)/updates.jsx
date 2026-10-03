import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View, Pressable } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { api } from '../../src/api.js';
import { useAuth } from '../../src/auth.jsx';
import { fmtDateTime, fmtRelative, fmtDate } from '../../src/format.js';
import {
  Card, Chip, StatusChip, Button, Empty, Loading, Segmented, Sheet, Progress,
  Banner, Toast, useToastState,
} from '../../src/ui.jsx';
import { TimeOffSheet } from '../../src/SafetyBar.jsx';
import { C, S } from '../../src/theme.js';

/* ------------------------------------------------------- training video -- */

/**
 * Required videos must be watched through. There is no media file in the demo,
 * so a real-time timer stands in for the player: it cannot be scrubbed forward,
 * and the server independently refuses an early completion.
 */
function TrainingPlayer({ training, onClose, onDone, notify }) {
  const [seconds, setSeconds] = useState(training.seconds_watched || 0);
  const [playing, setPlaying] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= training.duration_seconds) {
          setPlaying(false);
          return training.duration_seconds;
        }
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [playing, training.duration_seconds]);

  const enough = seconds >= Math.floor(training.duration_seconds * 0.95);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const complete = async () => {
    setSaving(true);
    try {
      await api.post(`/training/${training.id}/progress`, { secondsWatched: seconds, completed: true });
      notify('Training recorded.', 'ok');
      onDone();
      onClose();
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible
      title={training.title}
      onClose={async () => {
        try {
          await api.post(`/training/${training.id}/progress`, { secondsWatched: seconds });
          onDone();
        } catch {
          /* progress saving is best-effort */
        }
        onClose();
      }}
      footer={
        <>
          <Button title={playing ? 'Pause' : 'Resume'} variant="ghost" onPress={() => setPlaying((p) => !p)} />
          <Button
            title={enough ? 'Mark complete' : 'Watch in full to continue'}
            variant="primary"
            disabled={!enough}
            busy={saving}
            onPress={complete}
          />
        </>
      }
    >
      {!!training.required && (
        <Banner tone="warn" title="Required training">
          You must watch this in full before it can be marked complete.
        </Banner>
      )}
      <View
        style={{
          aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: C.navy800,
          alignItems: 'center', justifyContent: 'center', padding: 14,
        }}
      >
        <Text style={{ fontSize: 40, color: '#fff' }}>{playing ? '▶' : '❚❚'}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.8)', marginTop: 6, fontSize: 13 }}>
          {playing ? 'Playing' : 'Paused'}
        </Text>
        <View style={{ position: 'absolute', left: 12, right: 12, bottom: 10 }}>
          <Progress value={seconds} max={training.duration_seconds} ok={enough} />
          <View style={[S.rowBetween, { marginTop: 5 }]}>
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11 }}>{mmss(seconds)}</Text>
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11 }}>
              {mmss(training.duration_seconds)}
            </Text>
          </View>
        </View>
      </View>
      {!!training.description && <Text style={[S.small, S.muted]}>{training.description}</Text>}
    </Sheet>
  );
}

/* --------------------------------------------------------------- screen -- */

export default function UpdatesScreen() {
  const router = useRouter();
  const { signOut, user } = useAuth();
  const [toast, setToast] = useToastState();
  const notify = (message, tone) => setToast({ message, tone });

  const [tab, setTab] = useState('broadcasts');
  const [broadcasts, setBroadcasts] = useState(null);
  const [trainings, setTrainings] = useState([]);
  const [threads, setThreads] = useState([]);
  const [openBroadcast, setOpenBroadcast] = useState(null);
  const [player, setPlayer] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [timeOff, setTimeOff] = useState(false);
  const [myTimeOff, setMyTimeOff] = useState([]);
  const [pto, setPto] = useState(null);

  const load = useCallback(async () => {
    try {
      const [b, t, m, o] = await Promise.all([
        api.get('/broadcasts'),
        api.get('/training'),
        api.get('/messages/threads'),
        api.get('/time-off'),
      ]);
      setBroadcasts(b.broadcasts);
      setTrainings(t.trainings);
      setThreads(m.threads);
      setMyTimeOff(o.requests);
      api.get('/time-off/pto').then(setPto, () => setPto(null));
    } catch (err) {
      notify(err.message, 'err');
      setBroadcasts([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const openItem = async (b) => {
    setOpenBroadcast(b);
    if (b.unread) {
      try {
        await api.post(`/broadcasts/${b.id}/receipt`, {});
        load();
      } catch {
        /* reading matters more than the receipt */
      }
    }
  };

  const acknowledge = async () => {
    try {
      await api.post(`/broadcasts/${openBroadcast.id}/receipt`, { acknowledge: true });
      notify('Acknowledged.', 'ok');
      setOpenBroadcast(null);
      load();
    } catch (err) {
      notify(err.message, 'err');
    }
  };

  if (!broadcasts) return <Loading label="Loading updates" />;

  return (
    <View style={S.screen}>
      <ScrollView
        contentContainerStyle={S.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.brand600} />
        }
      >
        <View>
          <Text style={S.eyebrow}>Communication</Text>
          <Text style={S.h1}>Updates</Text>
        </View>

        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'broadcasts', label: 'Broadcasts' },
            { value: 'training', label: 'Training' },
            { value: 'messages', label: 'Messages' },
          ]}
        />

        {tab === 'broadcasts' && (
          <Card>
            {broadcasts.length === 0 ? (
              <Empty title="No messages">Company notices appear here.</Empty>
            ) : (
              broadcasts.map((b, i) => (
                <Pressable
                  key={b.id}
                  onPress={() => openItem(b)}
                  style={[S.listItem, i === broadcasts.length - 1 && { borderBottomWidth: 0 }]}
                >
                  <View style={S.grow}>
                    <View style={[S.row, S.wrap]}>
                      <Text style={[S.small, { fontWeight: b.unread ? '800' : '600' }]}>{b.title}</Text>
                      {b.priority !== 'normal' && <StatusChip value={b.priority} />}
                      {b.needs_ack && <Chip tone="brand">Action needed</Chip>}
                    </View>
                    <Text style={S.tiny} numberOfLines={1}>
                      {b.body}
                    </Text>
                    <Text style={S.tiny}>
                      {b.author} · {fmtRelative(b.published_at)}
                    </Text>
                  </View>
                  {b.unread && (
                    <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: C.brand600 }} />
                  )}
                </Pressable>
              ))
            )}
          </Card>
        )}

        {tab === 'training' && (
          <Card>
            {trainings.length === 0 ? (
              <Empty title="No training assigned" />
            ) : (
              trainings.map((t, i) => (
                <View key={t.id} style={[S.listItem, i === trainings.length - 1 && { borderBottomWidth: 0 }]}>
                  <View style={S.grow}>
                    <View style={[S.row, S.wrap]}>
                      <Text style={[S.small, S.strong]}>{t.title}</Text>
                      {!!t.required && <Chip tone={t.watched ? 'ok' : 'danger'}>Required</Chip>}
                      {t.overdue && <Chip tone="danger">Overdue</Chip>}
                    </View>
                    <Text style={S.tiny}>{t.description}</Text>
                    {!!t.due_at && !t.watched && <Text style={S.tiny}>Due {fmtDate(t.due_at)}</Text>}
                    {!t.watched && t.percent > 0 && (
                      <View style={{ marginTop: 5, maxWidth: 150 }}>
                        <Progress value={t.percent} max={100} />
                      </View>
                    )}
                  </View>
                  <Button
                    title={t.watched ? 'Rewatch' : t.percent > 0 ? 'Resume' : 'Watch'}
                    variant="primary"
                    onPress={() => setPlayer(t)}
                    style={{ paddingVertical: 9, paddingHorizontal: 13 }}
                  />
                </View>
              ))
            )}
          </Card>
        )}

        {tab === 'messages' && (
          <Card>
            {threads.length === 0 ? (
              <Empty title="No conversations">Your supervisor can start one with you.</Empty>
            ) : (
              threads.map((t, i) => (
                <Pressable
                  key={t.id}
                  onPress={() => router.push(`/thread/${t.id}`)}
                  style={[S.listItem, i === threads.length - 1 && { borderBottomWidth: 0 }]}
                >
                  <View style={S.grow}>
                    <Text style={[S.small, S.strong]}>{t.subject || t.participants}</Text>
                    <Text style={S.tiny} numberOfLines={1}>
                      {t.preview}
                    </Text>
                    <Text style={S.tiny}>{t.participants}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text style={S.tiny}>{fmtRelative(t.last_message_at)}</Text>
                    {t.unread > 0 && <Chip tone="brand">{t.unread}</Chip>}
                  </View>
                </Pressable>
              ))
            )}
          </Card>
        )}

        <Card
          title="Time off"
          right={
            <Pressable onPress={() => setTimeOff(true)}>
              <Text style={{ color: C.brand600, fontWeight: '700', fontSize: 13 }}>Request</Text>
            </Pressable>
          }
        >
          {pto?.eligible && (
            <View style={[S.cardPad, { paddingBottom: 4 }]}>
              <Text style={[S.small, S.strong]}>{`Paid time off: ${pto.balance} h`}</Text>
              <Text style={S.tiny}>
                {`${pto.available} h free to use${pto.pending ? `, ${pto.pending} h asked for` : ''}. An hour for every ${pto.rules.accrualWorkedHours} worked.`}
              </Text>
            </View>
          )}
          {myTimeOff.length === 0 ? (
            <Empty title="No requests">Ask for leave and your supervisor decides in the app.</Empty>
          ) : (
            myTimeOff.slice(0, 5).map((r, i) => (
              <View
                key={r.id}
                style={[S.listItem, i === Math.min(myTimeOff.length, 5) - 1 && { borderBottomWidth: 0 }]}
              >
                <View style={S.grow}>
                  <Text style={[S.small, S.strong]}>
                    {fmtDate(r.starts_on)} - {fmtDate(r.ends_on)}
                  </Text>
                  <Text style={S.tiny}>{`${r.type}${r.pto_hours ? ` · ${r.pto_hours} h paid` : ''}${r.pto_paid_in ? ` · paid ${r.pto_paid_in}` : ''}`}</Text>
                  {!!r.decision_note && <Text style={S.tiny}>{r.decision_note}</Text>}
                </View>
                <StatusChip value={r.status} />
              </View>
            ))
          )}
        </Card>

        <Card title="Account">
          <View style={S.cardPad}>
            <Text style={[S.small, S.strong]}>{user.full_name}</Text>
            <Text style={S.tiny}>Employee code {user.employee_code}</Text>
            <Button title="Change PIN" variant="ghost" onPress={() => router.push('/change-pin')} />
            <Button title="Sign out" variant="danger" onPress={signOut} />
          </View>
        </Card>
      </ScrollView>

      <Sheet
        visible={!!openBroadcast}
        title={openBroadcast?.title || ''}
        onClose={() => setOpenBroadcast(null)}
        footer={
          openBroadcast?.needs_ack ? (
            <Button title="I have read and understood" variant="primary" onPress={acknowledge} />
          ) : null
        }
      >
        {!!openBroadcast && (
          <>
            <View style={[S.row, S.wrap]}>
              <StatusChip value={openBroadcast.priority} />
              <Text style={[S.small, S.muted]}>
                {openBroadcast.author} · {fmtDateTime(openBroadcast.published_at)}
              </Text>
            </View>
            <Text style={[S.text, { lineHeight: 22 }]}>{openBroadcast.body}</Text>
            {!!openBroadcast.acknowledged_at && (
              <Banner tone="ok">Acknowledged {fmtDateTime(openBroadcast.acknowledged_at)}.</Banner>
            )}
          </>
        )}
      </Sheet>

      {!!player && (
        <TrainingPlayer
          training={player}
          onClose={() => setPlayer(null)}
          onDone={load}
          notify={notify}
        />
      )}

      <TimeOffSheet
        visible={timeOff}
        onClose={() => {
          setTimeOff(false);
          load();
        }}
        notify={notify}
      />


      <Toast toast={toast} />
    </View>
  );
}
