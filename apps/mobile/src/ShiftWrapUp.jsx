import { useEffect, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { api } from './api.js';
import { fmtTime } from './format.js';
import { formatDuration } from './shared.js';
import { Button, Field, Input, KeyValue, Loading, Sheet } from './ui.jsx';
import { C, S } from './theme.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * "Before you go": what the shift did, and - when the officer has not left
 * one - a nudge to write a pass-down note for the next shift. Clocking out
 * still works without one.
 */
export function ShiftWrapUp({ visible, onClose, onClockOut, busy, notify }) {
  const [summary, setSummary] = useState(null);
  const [note, setNote] = useState('');
  const [important, setImportant] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSummary(null);
    setNote('');
    setImportant(false);
    api.get('/timeclock/shift-summary').then(setSummary, () => setSummary({ failed: true }));
  }, [visible]);

  const finish = async () => {
    setSaving(true);
    try {
      if (note.trim()) await api.post('/post-log/passdown', { body: note.trim(), priority: important ? 'important' : 'normal' });
    } catch (err) {
      notify(`The note was not saved: ${err.message}`, 'err');
      setSaving(false);
      return;
    }
    setSaving(false);
    await onClockOut();
  };

  const ok = summary && !summary.failed;
  return (
    <Sheet
      visible={visible}
      title="Before you go"
      onClose={onClose}
      footer={
        <>
          <Button
            title={note.trim() ? 'Save note and clock out' : 'Clock out'}
            variant="primary"
            busy={saving || busy}
            onPress={finish}
          />
          <Button title="Stay on post" onPress={onClose} disabled={saving || busy} />
        </>
      }
    >
      {!summary ? (
        <Loading label="Adding up your shift" />
      ) : !ok ? (
        <Text style={[S.small, S.muted]}>Your shift summary did not load, but you can still clock out.</Text>
      ) : (
        <>
          <Text style={[S.small, S.muted]}>
            {summary.entry.post_name}, {summary.entry.site_name}. Since {fmtTime(summary.entry.clock_in_at)}.
          </Text>
          <KeyValue
            rows={[
              ['On post', formatDuration(summary.entry.minutes)],
              ['Check-ins', summary.checkIns.missed ? `${summary.checkIns.answered} answered, ${summary.checkIns.missed} missed` : `${summary.checkIns.answered} answered`],
              ['Patrols', summary.tours.runs ? `${plural(summary.tours.runs, 'tour')}, ${plural(summary.tours.checkpoints, 'checkpoint')}` : 'None walked'],
              ['Visitors', `${summary.visitorsIn} in, ${summary.visitorsOut} out`],
              ['Activity log', plural(summary.activity, 'entry', 'entries')],
              ['Incidents', summary.incidents ? plural(summary.incidents, 'report') : 'None'],
            ]}
          />
          {summary.passdownWritten === 0 ? (
            <>
              <Field label="Anything the next shift should know?" hint="Optional. It goes to the pass-down for this post.">
                <Input value={note} onChangeText={setNote} multiline style={{ minHeight: 90, textAlignVertical: 'top' }} />
              </Field>
              <View style={S.rowBetween}>
                <Text style={[S.small, S.strong, { color: C.ink }]}>Mark it important</Text>
                <Switch value={important} onValueChange={setImportant} accessibilityLabel="Mark it important" />
              </View>
            </>
          ) : (
            <Text style={S.small}>You left {plural(summary.passdownWritten, 'pass-down note')} this shift.</Text>
          )}
        </>
      )}
    </Sheet>
  );
}
