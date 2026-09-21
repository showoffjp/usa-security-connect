import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { api } from '../../src/api.js';
import { getPosition } from '../../src/geo.js';
import { fmtTime } from '../../src/format.js';
import {
  Card, Chip, StatusChip, Button, Loading, Progress, Sheet, Field, Input,
  Banner, Toast, useToastState,
} from '../../src/ui.jsx';
import { C, S } from '../../src/theme.js';

export default function TourRunScreen() {
  const { runId } = useLocalSearchParams();
  const router = useRouter();
  const navigation = useNavigation();
  const [toast, setToast] = useToastState();
  const notify = (message, tone) => setToast({ message, tone });

  const [data, setData] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [skip, setSkip] = useState(null);
  const [skipReason, setSkipReason] = useState('');
  const [manualTag, setManualTag] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const d = await api.get(`/tours/runs/${runId}`);
        setData(d);
        navigation.setOptions({ title: d.run.tour_name });
      } catch (err) {
        notify(err.message, 'err');
        setTimeout(() => router.back(), 800);
      }
    })();
  }, [runId]);

  /** Keep an open checkpoint sheet in sync after each scan or task change. */
  const update = (next) => {
    setData(next);
    if (sheet) {
      setSheet(next.checkpoints.find((c) => c.checkpoint_id === sheet.checkpoint_id) || null);
    }
  };

  const scan = async (checkpoint, tagId) => {
    setBusy(true);
    try {
      const fix = await getPosition({ timeout: 7000 });
      const res = await api.post(`/tours/runs/${runId}/checkpoints/${checkpoint.checkpoint_id}/scan`, {
        method: tagId ? 'nfc' : 'manual',
        tagId: tagId || undefined,
        latitude: fix.ok ? fix.latitude : null,
        longitude: fix.ok ? fix.longitude : null,
      });
      update(res);
      setManualTag('');
      notify(`${checkpoint.name} recorded.`, 'ok');
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const setTask = async (task, status) => {
    setBusy(true);
    try {
      update(await api.patch(`/tours/runs/${runId}/tasks/${task.id}`, { status }));
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const doSkip = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/tours/runs/${runId}/checkpoints/${skip.checkpoint_id}/skip`, {
        reason: skipReason.trim(),
      });
      setData(res);
      setSkip(null);
      setSkipReason('');
      notify('Checkpoint skipped - your supervisor will see the reason.', 'ok');
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/tours/runs/${runId}/complete`);
      notify(
        res.run.status === 'completed_with_skips' ? 'Tour finished with skipped checkpoints.' : 'Tour completed.',
        'ok'
      );
      setTimeout(() => router.back(), 700);
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Loading label="Loading tour" />;

  const { run, progress, checkpoints } = data;
  const finished = run.status !== 'in_progress';

  return (
    <View style={S.screen}>
      <ScrollView contentContainerStyle={S.content}>
        <Card>
          <View style={S.cardPad}>
            <View style={S.rowBetween}>
              <View style={S.grow}>
                <Text style={S.h2}>{run.tour_name}</Text>
                <Text style={[S.small, S.muted]}>
                  {run.site_name} · started {fmtTime(run.started_at)}
                </Text>
              </View>
              <Chip tone={progress.done === progress.total ? 'ok' : 'brand'}>
                {progress.done}/{progress.total}
              </Chip>
            </View>
            <Progress value={progress.done} max={progress.total} ok={progress.done === progress.total} />
          </View>
        </Card>

        <Card title="Checkpoints" right={<Text style={S.tiny}>In order</Text>}>
          {checkpoints.map((c, i) => {
            const doneTasks = c.tasks.filter((t) => t.status === 'done').length;
            return (
              <Pressable
                key={c.id}
                onPress={() => setSheet(c)}
                style={[S.listItem, i === checkpoints.length - 1 && { borderBottomWidth: 0 }]}
              >
                <View
                  style={[
                    S.leadIcon,
                    c.status === 'done' && { backgroundColor: C.okBg },
                    c.status === 'skipped' && { backgroundColor: C.warnBg },
                  ]}
                >
                  <Text
                    style={{
                      fontSize: 16,
                      color: c.status === 'done' ? C.ok : c.status === 'skipped' ? C.warn : C.navy700,
                    }}
                  >
                    {c.status === 'done' ? '✓' : c.status === 'skipped' ? '×' : String(i + 1)}
                  </Text>
                </View>
                <View style={S.grow}>
                  <Text style={[S.small, S.strong]}>
                    {c.name}
                    {!c.required ? <Text style={S.tiny}> (optional)</Text> : null}
                  </Text>
                  <Text style={S.tiny}>
                    {c.tasks.length > 0 ? `${doneTasks}/${c.tasks.length} tasks` : 'No tasks'}
                    {c.scanned_at ? ` · ${fmtTime(c.scanned_at)}` : ''}
                  </Text>
                  {!!c.skip_reason && <Text style={S.tiny}>Skipped: {c.skip_reason}</Text>}
                </View>
                {c.status === 'pending' ? (
                  <Chip tone="plain">Open</Chip>
                ) : (
                  <StatusChip value={c.status} />
                )}
              </Pressable>
            );
          })}
        </Card>

        {!finished && <Button title="Finish tour" variant="primary" onPress={finish} busy={busy} />}
      </ScrollView>

      {/* ------------------------------------------------ checkpoint sheet -- */}
      <Sheet
        visible={!!sheet}
        title={sheet?.name || ''}
        onClose={() => setSheet(null)}
        footer={
          sheet?.status === 'pending' && !finished ? (
            <>
              <Button
                title="Mark visited"
                variant="primary"
                busy={busy}
                onPress={() => scan(sheet, sheet.nfc_tag_id)}
              />
              <Button
                title="Skip this checkpoint"
                variant="ghost"
                onPress={() => {
                  setSkip(sheet);
                  setSheet(null);
                }}
              />
            </>
          ) : null
        }
      >
        {!!sheet && (
          <>
            {!!sheet.instructions && <Banner tone="info">{sheet.instructions}</Banner>}

            {sheet.status !== 'pending' && (
              <View style={S.row}>
                <StatusChip value={sheet.status} />
                {!!sheet.scanned_at && <Text style={[S.small, S.muted]}>at {fmtTime(sheet.scanned_at)}</Text>}
              </View>
            )}

            {sheet.tasks.length > 0 && (
              <View>
                <Text style={[S.tiny, { fontWeight: '800', letterSpacing: 0.6, marginBottom: 8 }]}>
                  CHECKPOINT TASKS
                </Text>
                <View style={S.card}>
                  {sheet.tasks.map((t, i) => (
                    <View
                      key={t.id}
                      style={[S.listItem, i === sheet.tasks.length - 1 && { borderBottomWidth: 0 }]}
                    >
                      <Pressable
                        disabled={busy}
                        onPress={() => setTask(t, t.status === 'done' ? 'pending' : 'done')}
                        hitSlop={8}
                      >
                        <View
                          style={{
                            width: 26, height: 26, borderRadius: 13,
                            alignItems: 'center', justifyContent: 'center',
                            backgroundColor: t.status === 'done' ? C.ok : C.surface3,
                          }}
                        >
                          <Text style={{ color: t.status === 'done' ? '#fff' : C.muted, fontWeight: '800' }}>
                            ✓
                          </Text>
                        </View>
                      </Pressable>
                      <Text
                        style={[
                          S.small,
                          S.grow,
                          t.status === 'skipped' && { textDecorationLine: 'line-through', color: C.muted },
                        ]}
                      >
                        {t.label}
                      </Text>
                      {t.status !== 'done' && (
                        <Pressable
                          disabled={busy}
                          onPress={() => setTask(t, t.status === 'skipped' ? 'pending' : 'skipped')}
                        >
                          <Text style={[S.small, { color: C.muted, fontWeight: '700' }]}>
                            {t.status === 'skipped' ? 'Undo' : 'Skip'}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  ))}
                </View>
              </View>
            )}

            {sheet.status === 'pending' && !!sheet.nfc_tag_id && (
              <Field label="Scan or type the tag ID" hint={`This checkpoint's tag: ${sheet.nfc_tag_id}`}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Input
                    value={manualTag}
                    onChangeText={setManualTag}
                    placeholder="USC-NFC-..."
                    style={S.grow}
                    autoCapitalize="characters"
                  />
                  <Button
                    title="Verify"
                    variant="navy"
                    disabled={!manualTag.trim()}
                    busy={busy}
                    onPress={() => scan(sheet, manualTag.trim())}
                  />
                </View>
              </Field>
            )}
          </>
        )}
      </Sheet>

      {/* ------------------------------------------------------ skip sheet -- */}
      <Sheet
        visible={!!skip}
        title={skip ? `Skip ${skip.name}?` : ''}
        onClose={() => {
          setSkip(null);
          setSkipReason('');
        }}
        footer={
          <Button
            title="Skip checkpoint"
            variant="danger"
            disabled={skipReason.trim().length < 3}
            busy={busy}
            onPress={doSkip}
          />
        }
      >
        <Field label="Why are you skipping it?" hint="Recorded on the tour record." required>
          <Input
            value={skipReason}
            onChangeText={setSkipReason}
            multiline
            style={{ height: 90, textAlignVertical: 'top' }}
            placeholder="e.g. Area locked down by the client for maintenance."
          />
        </Field>
      </Sheet>

      <Toast toast={toast} />
    </View>
  );
}
