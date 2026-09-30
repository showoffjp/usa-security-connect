import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../../src/api.js';
import { useAuth } from '../../src/auth.jsx';
import { getPosition, geoBody } from '../../src/geo.js';
import { fmtTime, fmtDay, fmtRange, fmtCountdown, fmtRelative } from '../../src/format.js';
import {
  Card, Chip, StatusChip, Button, Banner, KeyValue, SlideToAction, Loading,
  Sheet, Field, Input, Toast, useToastState,
} from '../../src/ui.jsx';
import { PanicButton, BreakControl } from '../../src/SafetyBar.jsx';
import { LocationCard } from '../../src/LocationCard.jsx';
import { PostLogCards, SiteContactsCard, usePostLog } from '../../src/PostLogCards.jsx';
import { C, S } from '../../src/theme.js';
import { formatDuration, toHours } from '../../src/shared.js';

/* ----------------------------------------------------- check-in prompt -- */

function CheckInCard({ checkIn, onAnswered, notify }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(checkIn.seconds_remaining);

  useEffect(() => {
    setLeft(checkIn.seconds_remaining);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [checkIn.id, checkIn.seconds_remaining]);

  const answer = async () => {
    setBusy(true);
    try {
      const fix = await getPosition({ timeout: 8000 });
      const res = await api.post('/timeclock/check-in', { checkId: checkIn.id, ...geoBody(fix) });
      notify(res.status === 'late' ? 'Check-in recorded (late).' : 'Check-in recorded. Stay safe.', 'ok');
      onAnswered();
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={checkIn.is_overdue ? { borderColor: '#F3C9C3' } : undefined}>
      <View style={[S.cardPad]}>
        <View style={S.rowBetween}>
          <Text style={S.h3}>Status check-in {checkIn.is_overdue ? 'overdue' : 'due'}</Text>
          <Chip tone={checkIn.is_overdue ? 'danger' : 'warn'}>{fmtCountdown(left)} left</Chip>
        </View>
        <Text style={[S.small, S.muted]}>
          Confirm you are safe and still on post. A missed check-in alerts your supervisor.
        </Text>
        <Button title="I'm on post and OK" variant="primary" onPress={answer} busy={busy} />
      </View>
    </Card>
  );
}

/* ---------------------------------------------------------------- home -- */

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [toast, setToast] = useToastState();
  const notify = (message, tone) => setToast({ message, tone });

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState(null);
  const [override, setOverride] = useState(null);
  const [reason, setReason] = useState('');
  const [pulls, setPulls] = useState(0);
  // Post orders, pass-down and contacts reload on pull-to-refresh and when duty changes.
  const postLog = usePostLog(`${status?.onDuty}-${pulls}`);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get('/timeclock/status'));
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // Warm a GPS fix so the slider does not stall when it is pulled.
  useEffect(() => {
    getPosition({ timeout: 9000 }).then(setFix);
  }, [status?.onDuty]);

  const clockIn = async (overrideReason) => {
    setBusy(true);
    try {
      const current = fix?.ok ? fix : await getPosition({ timeout: 9000 });
      setFix(current);
      const res = await api.post('/timeclock/clock-in', {
        ...geoBody(current),
        method: 'gps',
        shiftId: status?.shift?.id,
        postId: status?.shift?.post_id,
        overrideReason,
      });
      setOverride(null);
      setReason('');
      notify(
        res.lateMinutes > 0
          ? `Clocked in. You are ${res.lateMinutes} minutes late - this is recorded.`
          : 'Clocked in. Have a safe shift.',
        'ok'
      );
      await load();
    } catch (err) {
      if (err.status === 409 && ['outside_geofence', 'no_fix'].includes(err.details?.code)) {
        setOverride(err.details);
      } else {
        notify(err.message, 'err');
      }
    } finally {
      setBusy(false);
    }
  };

  const clockOut = async () => {
    setBusy(true);
    try {
      const current = await getPosition({ timeout: 9000 });
      const res = await api.post('/timeclock/clock-out', geoBody(current));
      notify(`Clocked out. ${formatDuration(res.minutesWorked)} on post.`, 'ok');
      await load();
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Checking your post" />;
  if (!status) return <Loading label="Retrying" />;

  const { onDuty, entry, shift, nextShift, lastEntry, checkIn, weekMinutes } = status;
  const post = entry || shift;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <View style={S.screen}>
      <ScrollView
        contentContainerStyle={S.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              setPulls((n) => n + 1);
              load();
            }}
            tintColor={C.brand600}
          />
        }
      >
        <View>
          <Text style={S.eyebrow}>{fmtDay(new Date())}</Text>
          <Text style={S.h1}>
            {greeting}, {user.first_name}
          </Text>
        </View>

        {checkIn?.is_open && <CheckInCard checkIn={checkIn} onAnswered={load} notify={notify} />}

        {/* Changed orders and unread pass-down come before anything else on post. */}
        <PostLogCards postLog={postLog} notify={notify} />

        {/* Breaks only make sense while the clock is running. */}
        {onDuty && <BreakControl notify={notify} onChanged={load} />}

        <Card
          title={onDuty ? 'Current post' : shift ? 'Your next post' : 'No post assigned'}
          right={onDuty ? <Chip tone="ok">On post</Chip> : null}
        >
          <View style={S.cardPad}>
            {post ? (
              <>
                <View>
                  <Text style={{ fontSize: 17, fontWeight: '700', color: C.ink }}>
                    {post.post_name}
                    {post.post_code ? <Text style={[S.small, S.muted]}> · {post.post_code}</Text> : null}
                  </Text>
                  <Text style={[S.small, S.muted]}>
                    {post.site_name}
                    {post.address ? ` - ${post.address}, ${post.city} ${post.state}` : ''}
                  </Text>
                </View>

                <KeyValue
                  rows={[
                    (shift || entry?.shift_starts_at) && [
                      'Scheduled',
                      `${fmtRange(
                        shift?.starts_at || entry.shift_starts_at,
                        shift?.ends_at || entry.shift_ends_at
                      )} (${fmtDay(shift?.starts_at || entry.shift_starts_at)})`,
                    ],
                    onDuty && [
                      'Clocked in',
                      `${fmtTime(entry.clock_in_at)} (${formatDuration(entry.minutes_on_post)} on post)`,
                    ],
                    onDuty && ['Location check', <StatusChip key="g" value={entry.clock_in_geofence} />],
                    onDuty && checkIn && !checkIn.is_open && [
                      'Next check-in',
                      `${fmtTime(checkIn.due_at)} (${fmtRelative(checkIn.due_at)})`,
                    ],
                    !onDuty && lastEntry && [
                      'Last clock-out',
                      `${fmtDay(lastEntry.clock_out_at)} at ${fmtTime(lastEntry.clock_out_at)}`,
                    ],
                  ]}
                />

                {!!post.instructions && (
                  <View style={{ backgroundColor: C.surface2, borderRadius: 10, padding: 12 }}>
                    <Text style={[S.tiny, { fontWeight: '800', color: C.navy700, marginBottom: 4, letterSpacing: 0.6 }]}>
                      OFFICER INSTRUCTIONS
                    </Text>
                    <Text style={[S.small, { lineHeight: 20 }]}>{post.instructions}</Text>
                  </View>
                )}
              </>
            ) : (
              <Banner tone="info" title="Nothing scheduled right now">
                {nextShift
                  ? `Your next shift is ${fmtDay(nextShift.starts_at)} at ${fmtTime(nextShift.starts_at)}, ${nextShift.post_name}.`
                  : 'Contact dispatch if you believe you should be on post.'}
              </Banner>
            )}

            {!onDuty && (
              <Text style={[S.tiny, { color: fix?.ok ? C.ok : C.warn }]}>
                {fix == null
                  ? 'Checking GPS...'
                  : fix.ok
                    ? `GPS ready (accurate to about ${fix.accuracy}m)`
                    : fix.message}
              </Text>
            )}

            {!!post && (
              <SlideToAction
                label={onDuty ? 'Slide to clock out' : 'Slide to clock in'}
                variant={onDuty ? 'out' : 'in'}
                busy={busy}
                onConfirm={onDuty ? clockOut : () => clockIn()}
              />
            )}
          </View>
        </Card>

        <LocationCard status={status} />

        <SiteContactsCard site={postLog.site} />

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Pressable style={[S.card, S.grow]} onPress={() => router.push('/incident-new')}>
            <View style={[S.cardPad, { gap: 4 }]}>
              <Text style={{ fontSize: 22 }}>⚠</Text>
              <Text style={[S.small, S.strong]}>Report an incident</Text>
              <Text style={S.tiny}>Photos, cost recovery</Text>
            </View>
          </Pressable>
          <Pressable style={[S.card, S.grow]} onPress={() => router.push('/tours')}>
            <View style={[S.cardPad, { gap: 4 }]}>
              <Text style={{ fontSize: 22 }}>◎</Text>
              <Text style={[S.small, S.strong]}>Start a tour</Text>
              <Text style={S.tiny}>Scan checkpoints</Text>
            </View>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Card style={S.grow}>
            <View style={S.cardPad}>
              <Text style={[S.tiny, { fontWeight: '800', letterSpacing: 0.6 }]}>HOURS THIS WEEK</Text>
              <Text style={{ fontSize: 26, fontWeight: '800', color: C.ink }}>{toHours(weekMinutes)}</Text>
            </View>
          </Card>
          <Card style={S.grow}>
            <View style={S.cardPad}>
              <Text style={[S.tiny, { fontWeight: '800', letterSpacing: 0.6 }]}>TRAINING DUE</Text>
              <Text style={{ fontSize: 26, fontWeight: '800', color: status.trainingDue ? C.warn : C.ink }}>
                {status.trainingDue}
              </Text>
            </View>
          </Card>
        </View>

        {/* Kept at the bottom so it is never hit by accident, but always one scroll away. */}
        <PanicButton notify={notify} />

        {!!nextShift && (
          <Card title="Next shift">
            <View style={[S.cardPad, S.rowBetween]}>
              <View style={S.grow}>
                <Text style={S.strong}>{nextShift.post_name}</Text>
                <Text style={[S.small, S.muted]}>{nextShift.site_name}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={S.strong}>{fmtDay(nextShift.starts_at)}</Text>
                <Text style={[S.small, S.muted]}>{fmtRange(nextShift.starts_at, nextShift.ends_at)}</Text>
              </View>
            </View>
          </Card>
        )}
      </ScrollView>

      <Sheet
        visible={!!override}
        title="Clock in from here?"
        onClose={() => {
          setOverride(null);
          setReason('');
        }}
        footer={
          <Button
            title="Clock in anyway"
            variant="primary"
            disabled={reason.trim().length < 5}
            busy={busy}
            onPress={() => clockIn(reason.trim())}
          />
        }
      >
        <Banner tone="warn" title="You are not at the post location">
          {override?.distance != null
            ? `Your phone reports you are about ${override.distance}m away. The limit for this post is ${override.radius}m.`
            : 'Your location could not be confirmed.'}
        </Banner>
        <Field
          label="Why are you clocking in from here?"
          hint="This goes to your supervisor with the clock-in record."
          required
        >
          <Input
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={4}
            style={{ height: 96, textAlignVertical: 'top' }}
            placeholder="e.g. Relieving at the north gate; the console is in the far building."
          />
        </Field>
      </Sheet>

      <Toast toast={toast} />
    </View>
  );
}
