import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { api } from '../../src/api.js';
import { fmtRelative } from '../../src/format.js';
import { Button, Input, Loading, Toast, useToastState } from '../../src/ui.jsx';
import { C, S } from '../../src/theme.js';

export default function ThreadScreen() {
  const { id } = useLocalSearchParams();
  const navigation = useNavigation();
  const router = useRouter();
  const [toast, setToast] = useToastState();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await api.get(`/messages/threads/${id}`);
        setData(d);
        navigation.setOptions({
          title: d.thread.subject || d.participants.map((p) => p.name).join(', '),
        });
      } catch (err) {
        setToast({ message: err.message, tone: 'err' });
        setTimeout(() => router.back(), 800);
      }
    })();
  }, [id]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    setBusy(true);
    try {
      const res = await api.post(`/messages/threads/${id}/messages`, { body });
      setData((d) => ({ ...d, messages: [...d.messages, res.message] }));
      setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 60);
    } catch (err) {
      setToast({ message: err.message, tone: 'err' });
      setDraft(body);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Loading label="Loading conversation" />;

  return (
    <KeyboardAvoidingView
      style={S.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        ref={scroller}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      >
        {data.messages.map((m) => (
          <View
            key={m.id}
            style={{
              alignSelf: m.mine ? 'flex-end' : 'flex-start',
              maxWidth: '82%',
              backgroundColor: m.mine ? C.navy800 : C.surface3,
              borderRadius: 14,
              paddingHorizontal: 13,
              paddingVertical: 9,
            }}
          >
            {!m.mine && (
              <Text style={{ fontSize: 11, fontWeight: '700', color: C.ink3, marginBottom: 2 }}>
                {m.sender_name}
              </Text>
            )}
            <Text style={{ fontSize: 14.5, color: m.mine ? '#fff' : C.ink, lineHeight: 20 }}>{m.body}</Text>
            <Text
              style={{
                fontSize: 10.5,
                color: m.mine ? 'rgba(255,255,255,0.65)' : C.muted,
                marginTop: 3,
              }}
            >
              {fmtRelative(m.sent_at)}
            </Text>
          </View>
        ))}
      </ScrollView>

      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          padding: 12,
          borderTopWidth: 1,
          borderTopColor: C.line,
          backgroundColor: C.surface,
        }}
      >
        <Input value={draft} onChangeText={setDraft} placeholder="Write a reply" style={S.grow} />
        <Button title="Send" variant="primary" onPress={send} disabled={!draft.trim()} busy={busy} />
      </View>
      <Toast toast={toast} />
    </KeyboardAvoidingView>
  );
}
