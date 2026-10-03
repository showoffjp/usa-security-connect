import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api } from './api.js';
import { fmtDate, fmtDateShort, fmtMoney } from './format.js';
import { expenseAmountCents } from './shared.js';
import { Banner, Button, Card, Chip, Empty, Field, Input, Sheet } from './ui.jsx';
import { Pick } from './HeldEquipment.jsx';
import { C, S } from './theme.js';

const TONE = { pending: 'warn', approved: 'brand', paid: 'ok', declined: 'danger', withdrawn: 'plain' };
const cents = (dollars) => fmtMoney(Math.round((dollars || 0) * 100));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The last week as pickable days; anything older is claimed on the web. */
function recentDays() {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return { value: ymd(d), label: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' }) };
  });
}

function ClaimSheet({ rules, categories, onClose, onDone, notify }) {
  const days = recentDays();
  const [category, setCategory] = useState('parking');
  const [incurredOn, setIncurredOn] = useState(days[0].value);
  const [amount, setAmount] = useState('');
  const [miles, setMiles] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const mileage = category === 'mileage';
  const total = expenseAmountCents({ category, miles: Number(miles) || 0, amountCents: Math.round((Number(amount) || 0) * 100) });
  const needsReceipt = !mileage && total > rules.receiptRequiredCents;
  const ready = total > 0 && description.trim().length >= 5 && (!needsReceipt || photo);

  const takePhoto = async (fromCamera) => {
    const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      notify('Permission is needed to add the receipt.', 'err');
      return;
    }
    const result = fromCamera ? await ImagePicker.launchCameraAsync({ quality: 0.6 }) : await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    if (!result.canceled && result.assets?.[0]) setPhoto(result.assets[0]);
  };

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const fd = new FormData();
      fd.append('category', category);
      fd.append('incurredOn', incurredOn);
      if (mileage) fd.append('miles', miles);
      else fd.append('amount', amount);
      fd.append('description', description.trim());
      if (photo && !mileage) {
        // React Native's FormData takes a {uri, name, type} descriptor.
        fd.append('receipt', { uri: photo.uri, name: photo.fileName || `receipt-${Date.now()}.jpg`, type: photo.mimeType || 'image/jpeg' });
      }
      await api.upload('/expenses', fd);
      notify('Claim sent. An administrator will look at it.', 'ok');
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      notify(err.message, 'err');
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible
      title="Claim an expense"
      onClose={onClose}
      footer={<Button variant="primary" title={`Claim ${fmtMoney(total)}`} busy={busy} disabled={!ready} onPress={save} />}
    >
      <Field label="What for" required error={errors.category}>
        <Pick label="What for" value={category} onChange={setCategory} options={categories} />
      </Field>
      <Field label="When" required error={errors.incurredOn} hint="Older than a week? Claim it from the web app.">
        <Pick label="When" value={incurredOn} onChange={setIncurredOn} options={days} />
      </Field>
      {mileage ? (
        <Field label="Miles driven" required error={errors.miles}
          hint={`Paid at ${rules.mileageRateCents}¢ a mile${Number(miles) > 0 ? `: ${fmtMoney(total)}` : ''}. No receipt needed.`}>
          <Input value={miles} onChangeText={(t) => setMiles(t.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" error={errors.miles} />
        </Field>
      ) : (
        <Field label="Amount ($)" required error={errors.amount} hint={`A receipt is needed over $${rules.receiptRequiredCents / 100}.`}>
          <Input value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" error={errors.amount} />
        </Field>
      )}
      <Field label="What it was for" required error={errors.description}>
        <Input value={description} onChangeText={setDescription} multiline maxLength={500} style={{ minHeight: 64, textAlignVertical: 'top' }}
          placeholder={mileage ? 'From where to where, and why.' : 'What you paid for, and why.'} />
      </Field>
      {!mileage && (
        <Field label="Receipt" required={needsReceipt} error={errors.receipt}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button title={photo ? 'Retake photo' : 'Take a photo'} onPress={() => takePhoto(true)} />
            <Button variant="ghost" title="From photos" onPress={() => takePhoto(false)} />
          </View>
          {photo && <Text style={[S.tiny, { marginTop: 6 }]}>Receipt photo added.</Text>}
        </Field>
      )}
      {needsReceipt && !photo && <Banner tone="info">{`Anything over $${rules.receiptRequiredCents / 100} needs a photo of the receipt.`}</Banner>}
    </Sheet>
  );
}

/** Money spent on the job, claimed back and paid with the payroll. */
export function MyExpenses({ notify }) {
  const [data, setData] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const load = useCallback(() => {
    api.get('/expenses/mine').then(setData, () => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;
  const { claims, summary } = data;

  const withdraw = async (c) => {
    try {
      await api.post(`/expenses/${c.id}/withdraw`);
      notify('Claim withdrawn.', 'ok');
      load();
    } catch (err) {
      notify(err.message, 'err');
    }
  };

  return (
    <>
      <Card title="My expenses" right={<Button variant="ghost" title="Claim" onPress={() => setClaiming(true)} style={{ paddingVertical: 6 }} />}>
        <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          <Text style={S.tiny}>
            {`Waiting ${cents(summary.pending)} · to be paid ${cents(summary.approved)} · paid ${cents(summary.paid)}`}
          </Text>
        </View>
        {claims.length === 0 ? (
          <Empty title="No claims yet">Parking, tolls, supplies or miles in your own car on the job: claim them here.</Empty>
        ) : (
          claims.slice(0, 8).map((c) => (
            <View key={c.id} style={{ padding: 14, gap: 4, borderTopWidth: 1, borderTopColor: C.line }}>
              <View style={[S.rowBetween, { gap: 8 }]}>
                <Text style={[S.small, S.strong, S.grow]}>{`${c.category_label} · ${cents(c.amount)}${c.miles != null ? ` (${c.miles} mi)` : ''}`}</Text>
                <Chip tone={TONE[c.status]}>{c.status_label}</Chip>
              </View>
              <Text style={S.tiny}>{`${fmtDate(c.incurred_on)} · ${c.description}`}</Text>
              {c.status === 'declined' && !!c.decision_note && <Text style={[S.tiny, { color: C.danger }]}>{`Declined: ${c.decision_note}`}</Text>}
              {c.status === 'approved' && <Text style={S.tiny}>Paid with the next payroll.</Text>}
              {!!c.paid_in && <Text style={S.tiny}>{`Paid with the payroll for ${c.paid_in.split(' to ').map(fmtDateShort).join(' to ')}`}</Text>}
              {c.status === 'pending' && (
                <Pressable onPress={() => withdraw(c)} accessibilityRole="button" hitSlop={8}>
                  <Text style={[S.tiny, { fontWeight: '700', textDecorationLine: 'underline', color: C.ink }]}>Withdraw</Text>
                </Pressable>
              )}
            </View>
          ))
        )}
      </Card>
      {claiming && (
        <ClaimSheet
          rules={data.rules}
          categories={data.categories}
          notify={notify}
          onClose={() => setClaiming(false)}
          onDone={() => {
            setClaiming(false);
            load();
          }}
        />
      )}
    </>
  );
}
