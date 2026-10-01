import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { api } from './api.js';
import { fmtRelative } from './format.js';
import { CALL_DISPOSITIONS, CALL_DISPOSITION_LABEL } from './shared.js';
import { Button, Card, Chip, Field, Input, Sheet } from './ui.jsx';
import { C, S } from './theme.js';

const TONE = { 1: 'danger', 2: 'warn', 3: 'plain' };

/**
 * A call the office has sent to this officer. It stays at the top of the
 * home screen until it is cleared: on my way, on scene, clear - or turned
 * back with a reason so the supervisor can send someone else.
 */
export function CallsCard({ onDuty, notify, refreshKey }) {
  const [calls, setCalls] = useState([]);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [disposition, setDisposition] = useState('resolved');
  const [outcome, setOutcome] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    if (!onDuty) {
      setCalls([]);
      return;
    }
    api.get('/dispatch/mine').then((d) => setCalls(d.active || []), () => {});
  }, [onDuty]);

  useEffect(() => {
    load();
    if (!onDuty) return undefined;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load, onDuty, refreshKey]);

  const act = async (call, step, body, message) => {
    setBusy(true);
    try {
      await api.post(`/dispatch/${call.id}/${step}`, body);
      notify(message, 'ok');
      setClearing(null);
      setDeclining(null);
      setOutcome('');
      setReason('');
      setDisposition('resolved');
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
      load();
    }
  };

  if (!calls.length) return null;
  return (
    <>
      {calls.map((c) => (
        <Card
          key={c.id}
          title={`${c.priority_label} call: ${c.type_label}`}
          right={<Chip tone={TONE[c.priority]}>{c.status_label}</Chip>}
          style={{ borderWidth: 2, borderColor: c.priority === 3 ? C.warn : C.danger }}
        >
          <View style={[S.cardPad, { gap: 6 }]}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>
              {c.site_name}
              {c.post_name ? ` · ${c.post_name}` : ''}
            </Text>
            {!!c.location && <Text style={S.small}>{c.location}</Text>}
            <Text style={[S.small, { lineHeight: 20 }]}>{c.description}</Text>
            <Text style={S.tiny}>
              Called in {fmtRelative(c.created_at)}
              {c.caller_name ? ` by ${c.caller_name}` : ''}
            </Text>
            {!!c.caller_phone && (
              <Pressable onPress={() => Linking.openURL(`tel:${c.caller_phone}`)} hitSlop={8}>
                <Text style={[S.small, { color: C.brand600, fontWeight: '700' }]}>Call {c.caller_phone}</Text>
              </Pressable>
            )}
            <View style={{ gap: 8, marginTop: 6 }}>
              {c.status === 'assigned' && (
                <Button variant="primary" title="On my way" busy={busy} onPress={() => act(c, 'acknowledge', {}, 'The office knows you are on the way.')} />
              )}
              {['assigned', 'en_route'].includes(c.status) && (
                <Button variant={c.status === 'en_route' ? 'primary' : 'default'} title="I'm on scene" busy={busy} onPress={() => act(c, 'arrive', {}, 'Marked on scene.')} />
              )}
              {c.status === 'on_scene' && <Button variant="primary" title="Clear call" onPress={() => setClearing(c)} />}
              {['assigned', 'en_route'].includes(c.status) && (
                <Button variant="ghost" title="I can't take it" disabled={busy} onPress={() => setDeclining(c)} />
              )}
            </View>
          </View>
        </Card>
      ))}

      <Sheet
        visible={Boolean(clearing)}
        title="Clear the call"
        onClose={() => setClearing(null)}
        footer={
          <Button
            variant="primary"
            title="Clear call"
            busy={busy}
            disabled={outcome.trim().length < 5}
            onPress={() => act(clearing, 'clear', { disposition, outcome }, 'Call cleared.')}
          />
        }
      >
        <Text style={S.label}>How did it end?</Text>
        <View style={{ gap: 6 }}>
          {CALL_DISPOSITIONS.map((d) => (
            <Pressable
              key={d}
              onPress={() => setDisposition(d)}
              style={{
                padding: 12, borderRadius: 10, borderWidth: 1,
                borderColor: disposition === d ? C.brand600 : C.line,
                backgroundColor: disposition === d ? C.surface3 : C.surface,
              }}
            >
              <Text style={{ fontWeight: disposition === d ? '700' : '400', color: C.ink }}>
                {disposition === d ? '● ' : '○ '}
                {CALL_DISPOSITION_LABEL[d]}
              </Text>
            </Pressable>
          ))}
        </View>
        <Field label="What you found and what you did" hint="The client reads this. Write an incident report as well for anything serious.">
          <Input value={outcome} onChangeText={setOutcome} multiline maxLength={1000} style={{ minHeight: 80, textAlignVertical: 'top' }} />
        </Field>
      </Sheet>

      <Sheet
        visible={Boolean(declining)}
        title="Turn the call back"
        onClose={() => setDeclining(null)}
        footer={
          <Button
            variant="danger"
            title="Turn it back"
            busy={busy}
            disabled={reason.trim().length < 3}
            onPress={() => act(declining, 'decline', { reason }, 'The call is back with the office.')}
          />
        }
      >
        <Field label="Why can't you take it?" hint="So the supervisor can send someone else straight away.">
          <Input value={reason} onChangeText={setReason} maxLength={300} />
        </Field>
      </Sheet>
    </>
  );
}
