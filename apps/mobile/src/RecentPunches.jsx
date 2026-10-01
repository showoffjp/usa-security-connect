import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDateShort, fmtTime } from './format.js';
import { formatDuration } from './shared.js';
import { Button, Card, Chip, Field, Input, Sheet } from './ui.jsx';
import { C, S } from './theme.js';

const TONE = { pending: 'warn', approved: 'ok', declined: 'danger', withdrawn: 'plain' };
const STEPS = [-15, -5, 5, 15];
const MIN = 60000;

/** A recorded time and four buttons to move it, which is all a phone needs for a few minutes either way. */
function Stepper({ label, recorded, offset, onChange }) {
  const value = new Date(new Date(recorded).getTime() + offset * MIN);
  return (
    <View style={{ gap: 6 }}>
      <Text style={S.label}>{label}</Text>
      <Text style={{ fontSize: 18, fontWeight: '800', color: offset ? C.brand600 : C.ink }}>
        {fmtTime(value)}
        {offset ? <Text style={[S.tiny, { fontWeight: '400' }]}>{`  was ${fmtTime(recorded)} (${offset > 0 ? '+' : ''}${offset} min)`}</Text> : null}
      </Text>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {STEPS.map((s) => (
          <Pressable
            key={s}
            onPress={() => onChange(offset + s)}
            accessibilityLabel={`${label} ${s > 0 ? 'later' : 'earlier'} by ${Math.abs(s)} minutes`}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line, alignItems: 'center' }}
          >
            <Text style={{ fontWeight: '700', color: C.ink }}>{s > 0 ? `+${s}` : s}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * The officer's punches from the last two weeks. A wrong one can be sent to
 * the office to fix, and their answer shows here.
 */
export function RecentPunches({ notify }) {
  const [data, setData] = useState(null);
  const [fixing, setFixing] = useState(null);
  const [inOffset, setInOffset] = useState(0);
  const [outOffset, setOutOffset] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/time-corrections/mine').then(setData, () => setData({ entries: [], windowDays: 14 }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const open = (e) => {
    setFixing(e);
    setInOffset(0);
    setOutOffset(0);
    setReason('');
  };

  const send = async () => {
    setBusy(true);
    try {
      await api.post('/time-corrections', {
        entryId: fixing.id,
        clockInAt: inOffset ? new Date(new Date(fixing.clock_in_at).getTime() + inOffset * MIN).toISOString() : null,
        clockOutAt: outOffset ? new Date(new Date(fixing.clock_out_at).getTime() + outOffset * MIN).toISOString() : null,
        reason,
      });
      notify('Sent to the office. Their answer will show here.', 'ok');
      setFixing(null);
      load();
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (c) => {
    try {
      await api.post(`/time-corrections/${c.id}/withdraw`);
      notify('Request withdrawn.', 'ok');
      load();
    } catch (err) {
      notify(err.message, 'err');
    }
  };

  if (!data || !data.entries.length) return null;
  return (
    <>
      <Card title="Your punches" right={<Text style={S.tiny}>{`Last ${data.windowDays} days`}</Text>}>
        {data.entries.map((e, i) => {
          const c = e.correction;
          return (
            <View
              key={e.id}
              style={{ padding: 14, gap: 4, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}
            >
              <Text style={{ fontWeight: '700', color: C.ink }}>
                {fmtDateShort(e.clock_in_at)} · {fmtTime(e.clock_in_at)} to {e.clock_out_at ? fmtTime(e.clock_out_at) : 'now'}
              </Text>
              <Text style={S.tiny}>
                {e.post_name}
                {e.minutes_worked != null ? ` · ${formatDuration(e.minutes_worked)}` : ''}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {e.auto_closed && <Chip tone="danger">Closed by the system</Chip>}
                {e.adjusted && <Chip tone="info">Corrected</Chip>}
                {c && <Chip tone={TONE[c.status]}>{c.status === 'pending' ? 'Correction waiting' : `Correction ${c.status}`}</Chip>}
              </View>
              {!!c?.decision_note && <Text style={S.small}>Office: {c.decision_note}</Text>}
              {c?.status === 'pending' ? (
                <Button variant="ghost" title="Withdraw the request" onPress={() => withdraw(c)} />
              ) : (
                e.clock_out_at && <Button title="Fix a time" onPress={() => open(e)} />
              )}
            </View>
          );
        })}
      </Card>

      <Sheet
        visible={Boolean(fixing)}
        title="Fix a time"
        onClose={() => setFixing(null)}
        footer={
          <Button
            variant="primary"
            title="Send to the office"
            busy={busy}
            disabled={(!inOffset && !outOffset) || reason.trim().length < 10}
            onPress={send}
          />
        }
      >
        {fixing && (
          <>
            <Text style={[S.small, S.muted]}>
              {fixing.post_name}, {fmtDateShort(fixing.clock_in_at)}
            </Text>
            <Stepper label="Clock-in" recorded={fixing.clock_in_at} offset={inOffset} onChange={setInOffset} />
            <Stepper label="Clock-out" recorded={fixing.clock_out_at} offset={outOffset} onChange={setOutOffset} />
            <Field label="What happened?" hint="For example: my relief was late and I stayed until they arrived.">
              <Input value={reason} onChangeText={setReason} multiline maxLength={500} style={{ minHeight: 80, textAlignVertical: 'top' }} />
            </Field>
          </>
        )}
      </Sheet>
    </>
  );
}
