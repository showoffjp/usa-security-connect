import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../src/auth.jsx';
import { Shield, Button, Field, Input, Banner } from '../src/ui.jsx';
import { C, S } from '../src/theme.js';
import { isWeakPin } from '../src/shared.js';

export default function ChangePinScreen() {
  const { forced } = useLocalSearchParams();
  const isForced = forced === '1';
  const { changePin, signOut } = useAuth();
  const router = useRouter();

  const [form, setForm] = useState({ currentPin: '', newPin: '', confirmPin: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (t) => setForm((f) => ({ ...f, [k]: t.replace(/\D/g, '') }));

  const submit = async () => {
    setError('');
    const next = {};
    if (!/^\d{4,6}$/.test(form.currentPin)) next.currentPin = 'Enter your current PIN.';
    if (!/^\d{4,6}$/.test(form.newPin)) next.newPin = 'Choose a 4-6 digit PIN.';
    else if (isWeakPin(form.newPin)) next.newPin = 'Avoid repeated digits (1111) and simple runs (1234).';
    if (form.newPin !== form.confirmPin) next.confirmPin = 'The two PINs do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await changePin(form.currentPin, form.newPin, form.confirmPin);
      if (!isForced) router.back();
      // When forced, the auth gate routes onward by itself.
    } catch (err) {
      setError(err.message);
      setErrors(err.fieldErrors || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.navy900 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 20 }}>
        <View style={{ backgroundColor: C.surface, borderRadius: 20, padding: 24, gap: 16 }}>
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Shield size={50} />
            <Text style={{ fontSize: 19, fontWeight: '800', color: C.ink }}>
              {isForced ? 'Choose your PIN' : 'Change your PIN'}
            </Text>
          </View>

          {isForced && (
            <Banner tone="info" title="One more step">
              You are signed in with the temporary PIN your supervisor issued. Pick your own before you go on post.
            </Banner>
          )}
          {!!error && <Banner tone="danger">{error}</Banner>}

          <Field label={isForced ? 'Temporary PIN' : 'Current PIN'} error={errors.currentPin} required>
            <Input
              value={form.currentPin}
              onChangeText={set('currentPin')}
              secureTextEntry
              keyboardType="number-pad"
              maxLength={6}
              error={!!errors.currentPin}
            />
          </Field>

          <Field
            label="New PIN"
            error={errors.newPin}
            hint="4 to 6 digits. Never share it - every clock-in is recorded against it."
            required
          >
            <Input
              value={form.newPin}
              onChangeText={set('newPin')}
              secureTextEntry
              keyboardType="number-pad"
              maxLength={6}
              error={!!errors.newPin}
            />
          </Field>

          <Field label="Confirm new PIN" error={errors.confirmPin} required>
            <Input
              value={form.confirmPin}
              onChangeText={set('confirmPin')}
              secureTextEntry
              keyboardType="number-pad"
              maxLength={6}
              error={!!errors.confirmPin}
            />
          </Field>

          <Button title="Save PIN" variant="primary" onPress={submit} busy={busy} />
          <Button
            title={isForced ? 'Sign out' : 'Cancel'}
            variant="ghost"
            onPress={isForced ? signOut : () => router.back()}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
