import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Switch, Text, View, Vibration } from 'react-native';
import { api } from './api.js';
import { getPosition, geoBody } from './geo.js';
import { fmtTime } from './format.js';
import { Card, Chip, Button, Banner, Sheet, Field, Input } from './ui.jsx';
import { C, S } from './theme.js';
import { formatDuration } from './shared.js';

/* ================================================================ panic === */

/**
 * Duress button.
 *
 * One tap opens a confirmation, and confirming fires immediately - it does not
 * wait for a GPS fix, which can take ten seconds an officer may not have. The
 * position is attached if it arrives, and sent as an update if it arrives late.
 */
export function PanicButton({ notify }) {
  const [alert, setAlert] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/panic/mine');
      setAlert(res.alert);
    } catch {
      /* the button still works even if the status check fails */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh]);

  const trigger = async () => {
    setBusy(true);
    Vibration.vibrate([0, 200, 100, 200]);
    try {
      // Fire first with whatever we have, then follow up with a precise fix.
      const res = await api.post('/panic', {});
      setAlert(res.alert);
      setConfirming(false);
      notify?.('Alert sent. Your supervisor has been notified.', 'ok');

      getPosition({ timeout: 15000 })
        .then((fix) => (fix.ok ? api.post('/panic', geoBody(fix)) : null))
        .catch(() => {});
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const standDown = async () => {
    setBusy(true);
    try {
      await api.post(`/panic/${alert.id}/stand-down`, {});
      setAlert(null);
      notify?.('Alert cancelled.', 'ok');
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (alert) {
    return (
      <Card style={{ borderColor: C.danger, borderWidth: 2 }}>
        <View style={S.cardPad}>
          <View style={S.rowBetween}>
            <Text style={[S.h3, { color: C.danger }]}>Duress alert active</Text>
            <Chip tone={alert.status === 'acknowledged' ? 'warn' : 'danger'}>
              {alert.status === 'acknowledged' ? 'Help responding' : 'Sent'}
            </Chip>
          </View>
          <Text style={[S.small, S.muted]}>
            {alert.status === 'acknowledged'
              ? `${alert.acknowledged_by_name || 'A supervisor'} has seen your alert and is on the way.`
              : 'Your supervisors have been notified. Keep the app open if you can.'}
          </Text>
          <Text style={S.tiny}>Triggered {fmtTime(alert.triggered_at)}</Text>

          <Button title="Call 911" variant="danger" onPress={() => Linking.openURL('tel:911')} />
          <Button title="I'm safe - stand down" variant="ghost" busy={busy} onPress={standDown} />
        </View>
      </Card>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setConfirming(true)}
        style={({ pressed }) => ({
          backgroundColor: pressed ? '#8f2a20' : C.danger,
          borderRadius: 14,
          paddingVertical: 16,
          alignItems: 'center',
          gap: 2,
        })}
      >
        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 17, letterSpacing: 0.5 }}>
          EMERGENCY
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>
          Alerts every supervisor with your location
        </Text>
      </Pressable>

      <Sheet
        visible={confirming}
        title="Send a duress alert?"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button title="Yes - send the alert now" variant="danger" busy={busy} onPress={trigger} />
            <Button title="Cancel" variant="ghost" onPress={() => setConfirming(false)} />
          </>
        }
      >
        <Banner tone="danger" title="This wakes up your supervisors">
          Use it when you are in danger or need help immediately. Your name, post and location go out
          straight away. If life is at risk, call 911 as well.
        </Banner>
        <Button title="Call 911 instead" variant="ghost" onPress={() => Linking.openURL('tel:911')} />
      </Sheet>
    </>
  );
}

/* =============================================================== breaks === */

/** Meal breaks are unpaid and come off the shift; rest breaks stay paid. */
export function BreakControl({ notify, onChanged }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setState(await api.get('/breaks/current'));
    } catch {
      setState({ onBreak: null, breaks: [] });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the elapsed counter honest while a break is running.
  useEffect(() => {
    if (!state?.onBreak) return;
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [state?.onBreak]);

  const start = async (type) => {
    setBusy(true);
    try {
      const fix = await getPosition({ timeout: 6000 });
      await api.post('/breaks/start', { type, ...geoBody(fix) });
      notify?.(type === 'meal' ? 'Meal break started. This is unpaid time.' : 'Rest break started.', 'ok');
      await refresh();
      onChanged?.();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    try {
      const res = await api.post('/breaks/end', {});
      notify?.(`Break ended after ${res.minutes} minutes.`, 'ok');
      await refresh();
      onChanged?.();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  if (state.onBreak) {
    const elapsed = state.onBreak.minutes_so_far + tick * 0;
    return (
      <Card style={{ borderColor: C.warn }}>
        <View style={S.cardPad}>
          <View style={S.rowBetween}>
            <Text style={S.h3}>
              On {state.onBreak.type === 'meal' ? 'meal' : 'rest'} break
            </Text>
            <Chip tone="warn">{formatDuration(elapsed)}</Chip>
          </View>
          <Text style={[S.small, S.muted]}>
            {state.onBreak.paid
              ? 'This break is paid.'
              : 'Unpaid - this time is deducted from your shift.'}
          </Text>
          <Button title="End break" variant="primary" busy={busy} onPress={end} />
        </View>
      </Card>
    );
  }

  return (
    <Card title="Breaks" right={state.totalUnpaidMinutes > 0 ? <Chip>{state.totalUnpaidMinutes}m unpaid</Chip> : null}>
      <View style={[S.cardPad, { flexDirection: 'row', gap: 10 }]}>
        <Button title="Meal break" variant="ghost" busy={busy} onPress={() => start('meal')} style={S.grow} />
        <Button title="Rest break" variant="ghost" busy={busy} onPress={() => start('rest')} style={S.grow} />
      </View>
    </Card>
  );
}

/* ============================================================= time off === */

export function TimeOffSheet({ visible, onClose, notify }) {
  const [form, setForm] = useState({ type: 'vacation', startsOn: '', endsOn: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [pto, setPto] = useState(null);
  const [paid, setPaid] = useState(true);
  const [hours, setHours] = useState('');

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  // The paid time off there is to use, read each time the sheet opens.
  useEffect(() => {
    if (visible) api.get('/time-off/pto').then(setPto, () => setPto(null));
  }, [visible]);

  const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const days = valid(form.startsOn) && valid(form.endsOn)
    ? Math.max(0, Math.round((new Date(`${form.endsOn}T12:00:00`) - new Date(`${form.startsOn}T12:00:00`)) / 86400000) + 1)
    : 0;
  const canPay = Boolean(pto?.eligible) && form.type !== 'unpaid' && pto.available > 0;
  const suggested = canPay ? Math.min(Math.max(days, 1) * 8, pto.available) : 0;
  const ptoHours = canPay && paid ? (hours === '' ? suggested : Number(hours)) : 0;

  const submit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(form.endsOn)) {
      notify?.('Enter both dates as YYYY-MM-DD.', 'err');
      return;
    }
    setBusy(true);
    try {
      await api.post('/time-off', { ...form, ptoHours: ptoHours > 0 ? ptoHours : undefined });
      notify?.('Request sent to your supervisor.', 'ok');
      setForm({ type: 'vacation', startsOn: '', endsOn: '', reason: '' });
      setHours('');
      onClose();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const types = ['vacation', 'sick', 'unpaid', 'bereavement', 'other'];

  return (
    <Sheet
      visible={visible}
      title="Request time off"
      onClose={onClose}
      footer={<Button title="Send request" variant="primary" busy={busy} onPress={submit} />}
    >
      <Field label="Type">
        <View style={[S.row, S.wrap, { gap: 7 }]}>
          {types.map((t) => (
            <Pressable key={t} onPress={() => set('type')(t)}>
              <View
                style={[
                  S.chip,
                  { paddingVertical: 7, paddingHorizontal: 12 },
                  form.type === t && { backgroundColor: C.navy800 },
                ]}
              >
                <Text style={[S.chipText, form.type === t && { color: '#fff' }]}>
                  {t[0].toUpperCase() + t.slice(1)}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </Field>

      <Field label="First day off" hint="YYYY-MM-DD" required>
        <Input value={form.startsOn} onChangeText={set('startsOn')} placeholder="2026-11-24" keyboardType="numbers-and-punctuation" />
      </Field>
      <Field label="Last day off" hint="YYYY-MM-DD" required>
        <Input value={form.endsOn} onChangeText={set('endsOn')} placeholder="2026-11-28" keyboardType="numbers-and-punctuation" />
      </Field>
      {canPay ? (
        <View style={{ gap: 8 }}>
          <View style={[S.rowBetween, { gap: 10 }]}>
            <Text style={[S.small, S.grow]}>{`Pay it from my paid time off (${pto.available} h free)`}</Text>
            <Switch value={paid} onValueChange={setPaid} accessibilityLabel="Pay it from my paid time off" />
          </View>
          {paid && (
            <Field label="Hours from my balance" hint={`Eight a day is suggested; at most ${pto.rules.dayMaxHours} a day.`}>
              <Input value={hours} onChangeText={(t) => setHours(t.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" placeholder={String(suggested)} />
            </Field>
          )}
        </View>
      ) : pto?.eligible && form.type !== 'unpaid' ? (
        <Text style={S.tiny}>No paid time off free to use, so this would be unpaid.</Text>
      ) : null}

      <Field label="Reason" hint="Optional, but it helps the decision.">
        <Input
          value={form.reason}
          onChangeText={set('reason')}
          multiline
          style={{ height: 80, textAlignVertical: 'top' }}
        />
      </Field>
    </Sheet>
  );
}
