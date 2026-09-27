import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useAuth } from '../src/auth.jsx';
import { Shield, Button, Field, Input, Banner } from '../src/ui.jsx';
import { C, S } from '../src/theme.js';

/**
 * PINs are 4 to 6 digits. A six-digit PIN signs in by itself; a shorter one
 * with the Sign in button.
 */
const PIN_MIN = 4;
const PIN_MAX = 6;

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [step, setStep] = useState('code');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const attempt = async (fullPin) => {
    setBusy(true);
    setError('');
    try {
      await signIn(code, fullPin);
      // The auth gate swaps this screen out on success.
    } catch (err) {
      setError(err.message);
      setPin('');
      setBusy(false);
    }
  };

  useEffect(() => {
    if (pin.length === PIN_MAX && !busy) attempt(pin);
  }, [pin]);

  const press = (digit) => {
    if (busy || pin.length >= PIN_MAX) return;
    setPin((p) => p + digit);
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'del'];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.navy900 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 20 }}>
        <View style={{ backgroundColor: C.surface, borderRadius: 20, padding: 24, gap: 18 }}>
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Shield size={58} />
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.3 }}>
                USA Security Connect
              </Text>
              <Text
                style={{
                  fontSize: 11, letterSpacing: 2, color: C.muted,
                  fontWeight: '700', marginTop: 2,
                }}
              >
                PROTECTION GROUP
              </Text>
            </View>
          </View>

          {!!error && <Banner tone="danger">{error}</Banner>}

          {step === 'code' ? (
            <View style={{ gap: 16 }}>
              <Field label="Employee code" hint="Your supervisor issues this code and your starting PIN.">
                <Input
                  value={code}
                  onChangeText={(t) => setCode(t.replace(/\D/g, ''))}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="0000"
                  autoFocus
                  style={{ fontSize: 24, letterSpacing: 10, textAlign: 'center', fontWeight: '600' }}
                />
              </Field>
              <Button
                title="Continue"
                variant="primary"
                onPress={() => {
                  if (!/^\d{4,6}$/.test(code)) {
                    setError('Enter the 4-digit employee code from your assignment sheet.');
                    return;
                  }
                  setError('');
                  setStep('pin');
                }}
              />
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <View style={{ alignItems: 'center' }}>
                <Text style={[S.small, S.muted]}>Employee code</Text>
                <Text style={{ fontSize: 18, fontWeight: '700', letterSpacing: 4, color: C.ink }}>
                  {code}
                </Text>
              </View>

              <Text style={[S.small, S.muted, { textAlign: 'center' }]}>
                Enter your PIN
              </Text>

              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 13 }}>
                {Array.from({ length: Math.max(PIN_MIN, pin.length) }).map((_, i) => (
                  <View
                    key={i}
                    style={{
                      width: 15, height: 15, borderRadius: 8, borderWidth: 2,
                      borderColor: i < pin.length ? C.brand600 : C.line2,
                      backgroundColor: i < pin.length ? C.brand600 : 'transparent',
                    }}
                  />
                ))}
              </View>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                {keys.map((k) => {
                  const isAction = k === 'back' || k === 'del';
                  return (
                    <Pressable
                      key={k}
                      disabled={busy}
                      onPress={() => {
                        if (k === 'back') {
                          setStep('code');
                          setPin('');
                          setError('');
                        } else if (k === 'del') setPin((p) => p.slice(0, -1));
                        else press(k);
                      }}
                      style={({ pressed }) => ({
                        width: '30%', paddingVertical: 15, borderRadius: 10,
                        alignItems: 'center',
                        backgroundColor: isAction ? 'transparent' : C.surface2,
                        borderWidth: isAction ? 0 : 1,
                        borderColor: C.line,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Text
                        style={{
                          fontSize: isAction ? 14 : 22,
                          fontWeight: isAction ? '700' : '600',
                          color: isAction ? C.muted : C.ink,
                        }}
                      >
                        {k === 'back' ? 'Back' : k === 'del' ? 'Delete' : k}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Button
                title={busy ? 'Signing in...' : 'Sign in'}
                variant="primary"
                disabled={busy || pin.length < PIN_MIN}
                onPress={() => attempt(pin)}
              />
            </View>
          )}

          <Text style={[S.tiny, { textAlign: 'center', lineHeight: 17 }]}>
            Forgotten your PIN? Contact your field supervisor for a reset.{'\n'}
            Licensed Florida security agency &middot; B 3400341
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
