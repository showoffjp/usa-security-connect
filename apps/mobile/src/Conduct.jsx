import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDate } from './format.js';
import { Button, Card, Chip, Field, Input, Sheet } from './ui.jsx';
import { C, S } from './theme.js';

const LEVEL_TONE = { coaching: 'info', verbal_warning: 'warn', written_warning: 'warn', final_warning: 'danger', suspension: 'danger' };

/**
 * On the home screen: a coaching or warning the officer has not signed yet.
 * They read it, may add their side, and sign by typing their name.
 */
export function ConductToSign({ user, notify, refreshKey }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [signature, setSignature] = useState('');
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get('/conduct/mine').then(setData, () => setData(null));
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (!data || !data.awaiting) return null;
  const waiting = data.records.filter((r) => r.awaiting_signature);
  const close = () => {
    setOpen(null);
    setSignature('');
    setStatement('');
  };
  const sign = async () => {
    setBusy(true);
    try {
      await api.post(`/conduct/mine/${open.id}/acknowledge`, { signature: signature.trim(), statement: statement.trim() || undefined });
      notify?.('Signed. A copy stays on your record.', 'ok');
      close();
      load();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const name = user ? `${user.first_name} ${user.last_name}` : '';

  return (
    <Card title="To read and sign" right={<Chip tone="warn">{waiting.length}</Chip>}>
      {waiting.map((r, i) => (
        <View key={r.id} style={[S.listItem, i === waiting.length - 1 && { borderBottomWidth: 0 }]}>
          <View style={S.grow}>
            <Text style={[S.small, S.strong]}>{`${r.level_label}: ${r.category_label.toLowerCase()}`}</Text>
            <Text style={S.tiny}>{`${fmtDate(r.occurred_on)}${r.issued_by_name ? ` · from ${r.issued_by_name}` : ''}`}</Text>
          </View>
          <Button title="Read" variant="primary" onPress={() => setOpen(r)} style={{ paddingVertical: 9, paddingHorizontal: 14 }} />
        </View>
      ))}
      <Sheet
        visible={!!open}
        title={open ? open.level_label : ''}
        onClose={close}
        footer={<Button title={busy ? 'Signing...' : 'Sign'} variant="primary" onPress={sign} disabled={busy || signature.trim().length < 2} />}
      >
        {open && (
          <>
            <View style={[S.row, S.wrap, { gap: 6 }]}>
              <Chip tone={LEVEL_TONE[open.level] || 'plain'}>{open.level_label}</Chip>
              <Text style={S.tiny}>{`${open.category_label} · ${fmtDate(open.occurred_on)}`}</Text>
            </View>
            {open.level === 'suspension' && !!open.suspension_starts_on && (
              <Text style={S.small}>{`Off work: ${fmtDate(open.suspension_starts_on)} to ${fmtDate(open.suspension_ends_on)}`}</Text>
            )}
            <Text style={S.small}>
              <Text style={S.strong}>What happened: </Text>
              {open.summary}
            </Text>
            <Text style={S.small}>
              <Text style={S.strong}>Expected from now on: </Text>
              {open.expectations}
            </Text>
            <Field label="Your side of it" hint="Optional. Kept with the record, word for word.">
              <Input value={statement} onChangeText={setStatement} multiline maxLength={2000} style={{ minHeight: 80, textAlignVertical: 'top' }} />
            </Field>
            <Field label="Type your full name to sign" required hint={`Signing says you have read it, not that you agree.${name ? ` Type: ${name}` : ''}`}>
              <Input value={signature} onChangeText={setSignature} autoCapitalize="words" maxLength={120} />
            </Field>
            <Text style={[S.tiny, { color: C.ink3 }]}>It stays on your record for a year unless withdrawn.</Text>
          </>
        )}
      </Sheet>
    </Card>
  );
}
