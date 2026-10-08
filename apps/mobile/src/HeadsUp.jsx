import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDay, fmtTime } from './format.js';
import { Banner, Button, Card, Field, Input, Segmented, Sheet } from './ui.jsx';
import { C, S } from './theme.js';

const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`);
/** How late, in minutes past the start, or in minutes from now once it has started. */
const LATE_BY = [10, 15, 20, 30, 45, 60];
/** The card is a full card this close to the start; before that, one line. */
const SOON_MINUTES = 120;

/**
 * On the home screen before the officer's next shift: tell the supervisors
 * they are running late, or that they cannot come at all, before it becomes
 * a no-show. The same as the web app's.
 */
export function HeadsUpCard({ notify, refreshKey }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [by, setBy] = useState(15);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get('/heads-up').then(setData, () => setData(null));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, refreshKey]);
  if (!data?.shift) return null;
  const { shift, notice, reasons } = data;

  const close = () => {
    setOpen(null);
    setNote('');
    setReason('');
    setBusy(false);
  };
  const etaMinutes = shift.started ? by : Math.max(5, shift.minutes_to_start + by);
  const send = async (path, body, done) => {
    setBusy(true);
    try {
      await api.post(`/heads-up/${shift.id}/${path}`, body);
      notify(done, 'ok');
      close();
      load();
    } catch (err) {
      notify(err.message, 'err');
      setBusy(false);
    }
  };
  const soon = shift.started || shift.minutes_to_start <= SOON_MINUTES || notice;

  return (
    <>
      {soon ? (
        <Card title={shift.started ? 'Your shift has started' : 'Your next shift'}>
          <View style={{ gap: 10 }}>
            <View>
              <Text style={[S.small, S.strong]}>{shift.post_name}</Text>
              <Text style={[S.tiny, S.muted]}>
                {shift.site_name}.{' '}
                {shift.started
                  ? `Started ${fmtTime(shift.starts_at)}, and you have not clocked in.`
                  : `${fmtDay(shift.starts_at)} at ${fmtTime(shift.starts_at)}, in ${mins(shift.minutes_to_start)}.`}
              </Text>
            </View>
            {notice ? (
              <Banner tone="info" title="Your supervisors know you are running late">
                {`You said you would be there by ${fmtTime(notice.eta_at)}${notice.note ? `: "${notice.note}"` : '.'}`}
              </Banner>
            ) : (
              <Text style={[S.small, S.muted]}>Running late or can't make it? Tell your supervisors now, before it is a no-show.</Text>
            )}
            {!notice && <Button title="Running late" variant="primary" onPress={() => setOpen('late')} />}
            <Button title="Can't make it" variant="ghost" onPress={() => setOpen('off')} />
          </View>
        </Card>
      ) : (
        <Card>
          <View style={[S.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={[S.small, S.muted, S.grow]}>
              Can't make your {fmtTime(shift.starts_at)} shift at {shift.post_name}?
            </Text>
            <Button title="Call off" variant="ghost" onPress={() => setOpen('off')} />
          </View>
        </Card>
      )}

      <Sheet
        visible={open === 'late'}
        title="Running late"
        onClose={close}
        footer={
          <Button
            title={busy ? 'Sending...' : 'Tell my supervisors'}
            variant="primary"
            busy={busy}
            onPress={() => send('running-late', { etaMinutes, note: note.trim() || undefined }, 'Your supervisors know you are on your way.')}
          />
        }
      >
        <Text style={[S.small, S.muted]}>
          {shift.post_name}, {shift.started ? 'started' : 'starts'} {fmtTime(shift.starts_at)}. You can say this once; if it changes again, call
          your supervisor.
        </Text>
        <Text style={[S.small, S.strong]}>{shift.started ? 'I will be there in (minutes)' : 'How many minutes late?'}</Text>
        <Segmented value={by} onChange={setBy} options={LATE_BY.map((m) => ({ value: m, label: String(m) }))} />
        <Text style={S.small}>You expect to arrive by {fmtTime(new Date(Date.now() + etaMinutes * 60000))}.</Text>
        <Field label="Anything they should know" hint="Optional.">
          <Input value={note} onChangeText={setNote} maxLength={200} placeholder="Stuck in traffic on I-95" />
        </Field>
      </Sheet>

      <Sheet
        visible={open === 'off'}
        title="Can't make it"
        onClose={close}
        footer={
          <Button
            title={busy ? 'Sending...' : 'Call off this shift'}
            variant="danger"
            busy={busy}
            disabled={!reason || (reason === 'other' && note.trim().length < 5)}
            onPress={() => send('call-off', { reason, note: note.trim() || undefined }, 'Called off. Your supervisors have been told.')}
          />
        }
      >
        <Banner tone="warn" title={`${shift.post_name}, ${fmtDay(shift.starts_at)} ${fmtTime(shift.starts_at)}`}>
          The shift is taken off you and opened for other officers, and your supervisors are texted now so they can find cover. For a day or
          more off, request time off instead.
        </Banner>
        <Text style={[S.small, S.strong]}>Why can't you come?</Text>
        <View style={{ gap: 8 }}>
          {(reasons || []).map((r) => (
            <Pressable
              key={r.value}
              onPress={() => setReason(r.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: reason === r.value }}
              style={{
                padding: 12, borderRadius: 10, borderWidth: 1,
                borderColor: reason === r.value ? C.brand600 : C.line2,
                backgroundColor: reason === r.value ? C.brand100 : C.surface,
              }}
            >
              <Text style={[S.small, reason === r.value && S.strong]}>{r.label}</Text>
            </Pressable>
          ))}
        </View>
        <Field label="A few words for your supervisor" hint={reason === 'other' ? 'Required for something else.' : 'Optional.'}>
          <Input value={note} onChangeText={setNote} maxLength={300} multiline />
        </Field>
      </Sheet>
    </>
  );
}
