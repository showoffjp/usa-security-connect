import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../src/api.js';
import { getPosition } from '../src/geo.js';
import { Button, Card, Field, Input, Banner, Toast, useToastState } from '../src/ui.jsx';
import { C, S } from '../src/theme.js';

/** Field supervisors log a post visit while standing at the post. */
export default function SupervisorVisitScreen() {
  const router = useRouter();
  const [toast, setToast] = useToastState();
  const notify = (message, tone) => setToast({ message, tone });

  const [posts, setPosts] = useState([]);
  const [officers, setOfficers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    postId: null,
    officerId: null,
    uniformOk: true,
    postOrdersReviewed: true,
    equipmentOk: true,
    siteSecure: true,
    rating: 5,
    notes: '',
    clientNote: '',
  });

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    (async () => {
      try {
        const [ref, contacts] = await Promise.all([api.get('/reference'), api.get('/messages/contacts')]);
        setPosts(ref.posts);
        setOfficers(contacts.contacts.filter((c) => c.role === 'officer'));
      } catch {
        /* the form still works without the pick lists */
      }
    })();
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const fix = await getPosition({ timeout: 8000 });
      const post = posts.find((p) => p.id === form.postId);
      await api.post('/visits', {
        postId: form.postId ?? undefined,
        siteId: post?.site_id ?? undefined,
        officerId: form.officerId ?? undefined,
        visitedAt: new Date().toISOString(),
        uniformOk: form.uniformOk,
        postOrdersReviewed: form.postOrdersReviewed,
        equipmentOk: form.equipmentOk,
        siteSecure: form.siteSecure,
        rating: form.rating,
        notes: form.notes || undefined,
        clientNote: form.clientNote || undefined,
        latitude: fix.ok ? fix.latitude : null,
        longitude: fix.ok ? fix.longitude : null,
      });
      notify('Visit logged.', 'ok');
      setTimeout(() => router.back(), 700);
    } catch (err) {
      notify(err.message, 'err');
      setBusy(false);
    }
  };

  const Toggle = ({ label, value, onChange }) => (
    <View style={S.rowBetween}>
      <Text style={[S.small, S.grow]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: C.brand400 }}
        thumbColor={value ? C.brand600 : undefined}
      />
    </View>
  );

  const Picker = ({ items, value, onChange, labelKey = 'name' }) => (
    <View style={[S.row, S.wrap, { gap: 7 }]}>
      {items.map((item) => {
        const active = value === item.id;
        return (
          <Pressable key={item.id} onPress={() => onChange(active ? null : item.id)}>
            <View
              style={[
                S.chip,
                { paddingVertical: 7, paddingHorizontal: 12 },
                active && { backgroundColor: C.navy800 },
              ]}
            >
              <Text style={[S.chipText, active && { color: '#fff' }]}>{item[labelKey]}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={S.content} keyboardShouldPersistTaps="handled">
        <View>
          <Text style={S.eyebrow}>Field supervision</Text>
          <Text style={S.h1}>Log a post visit</Text>
        </View>

        <Banner tone="info">
          Your GPS position is recorded with the visit. The client sees that the post was visited, and your note for them.
        </Banner>

        <Card title="Where and who">
          <View style={S.cardPad}>
            <Field label="Post">
              <Picker items={posts} value={form.postId} onChange={set('postId')} />
            </Field>
            <Field label="Officer on post">
              <Picker items={officers} value={form.officerId} onChange={set('officerId')} />
            </Field>
          </View>
        </Card>

        <Card title="Checks">
          <View style={S.cardPad}>
            <Toggle label="Uniform and appearance correct" value={form.uniformOk} onChange={set('uniformOk')} />
            <View style={S.divider} />
            <Toggle
              label="Post orders reviewed with the officer"
              value={form.postOrdersReviewed}
              onChange={set('postOrdersReviewed')}
            />
            <View style={S.divider} />
            <Toggle label="Equipment present and working" value={form.equipmentOk} onChange={set('equipmentOk')} />
            <View style={S.divider} />
            <Toggle label="Site secure" value={form.siteSecure} onChange={set('siteSecure')} />
          </View>
        </Card>

        <Card title="Rating">
          <View style={S.cardPad}>
            <View style={[S.row, { gap: 8 }]}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} onPress={() => set('rating')(n)} style={S.grow}>
                  <View
                    style={{
                      paddingVertical: 12,
                      borderRadius: 10,
                      alignItems: 'center',
                      backgroundColor: form.rating === n ? C.brand600 : C.surface3,
                    }}
                  >
                    <Text style={{ fontWeight: '800', color: form.rating === n ? '#fff' : C.ink3 }}>{n}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
            <Field label="Notes (internal)" hint="What you observed, and anything you coached the officer on. The client never sees this.">
              <Input
                value={form.notes}
                onChangeText={set('notes')}
                multiline
                style={{ height: 110, textAlignVertical: 'top' }}
              />
            </Field>
            <Field label="Note for the client" hint="What the property's contacts read in the portal. Leave it empty to show the visit alone.">
              <Input
                value={form.clientNote}
                onChangeText={set('clientNote')}
                multiline
                style={{ height: 80, textAlignVertical: 'top' }}
              />
            </Field>
          </View>
        </Card>

        <Button title="Log visit" variant="primary" onPress={submit} busy={busy} disabled={!form.postId} />
        <Button title="Cancel" variant="ghost" onPress={() => router.back()} disabled={busy} />
      </ScrollView>
      <Toast toast={toast} />
    </KeyboardAvoidingView>
  );
}
