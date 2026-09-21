import { useEffect, useState } from 'react';
import {
  Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../src/api.js';
import { useAuth } from '../src/auth.jsx';
import { Button, Field, Input, Banner, Card, Toast, useToastState } from '../src/ui.jsx';
import { C, S } from '../src/theme.js';
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITY } from '../src/shared.js';

const MAX_PHOTOS = 8;

/** Compact picker: a row of tappable chips beats a native picker on a phone. */
function ChipPicker({ options, value, onChange, allowEmpty = false }) {
  return (
    <View style={[S.row, S.wrap, { gap: 7 }]}>
      {allowEmpty && (
        <Pressable onPress={() => onChange('')}>
          <View
            style={[
              S.chip,
              { paddingVertical: 7, paddingHorizontal: 12 },
              !value && { backgroundColor: C.navy800 },
            ]}
          >
            <Text style={[S.chipText, !value && { color: '#fff' }]}>Any</Text>
          </View>
        </Pressable>
      )}
      {options.map((o) => {
        const active = value === o;
        return (
          <Pressable key={o} onPress={() => onChange(o)}>
            <View
              style={[
                S.chip,
                { paddingVertical: 7, paddingHorizontal: 12 },
                active && { backgroundColor: C.navy800 },
              ]}
            >
              <Text style={[S.chipText, active && { color: '#fff' }]}>
                {o[0].toUpperCase() + o.slice(1)}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function NewIncidentScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [toast, setToast] = useToastState();
  const notify = (message, tone) => setToast({ message, tone });

  const [posts, setPosts] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    officerName: user.full_name,
    callbackNumber: user.phone || '',
    category: '',
    severity: 'low',
    postId: null,
    locationText: '',
    whatHappened: '',
    resolution: '',
    otherDetails: '',
    peopleInvolved: '',
    peopleNotified: '',
    policeNotified: false,
    policeReportNumber: '',
    costRecovery: '',
  });

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    (async () => {
      try {
        const [ref, status] = await Promise.all([api.get('/reference'), api.get('/timeclock/status')]);
        setPosts(ref.posts);
        const postId = status.entry?.post_id || status.shift?.post_id;
        if (postId) set('postId')(postId);
      } catch {
        /* the officer can still file without a post */
      }
    })();
  }, []);

  const addPhoto = async (fromCamera) => {
    if (photos.length >= MAX_PHOTOS) {
      notify(`Only ${MAX_PHOTOS} photos per report.`, 'err');
      return;
    }
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      notify('Permission is needed to attach photos.', 'err');
      return;
    }

    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6, allowsMultipleSelection: true });

    if (result.canceled) return;
    const incoming = result.assets.slice(0, MAX_PHOTOS - photos.length);
    setPhotos((p) => [...p, ...incoming]);
  };

  const submit = async () => {
    const next = {};
    if (form.whatHappened.trim().length < 10) next.whatHappened = 'Describe what happened in at least a sentence.';
    setErrors(next);
    if (Object.keys(next).length) {
      notify('Please correct the highlighted fields.', 'err');
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      const append = (k, v) => {
        if (v !== '' && v != null && v !== false) fd.append(k, String(v));
      };
      append('officerName', form.officerName);
      append('callbackNumber', form.callbackNumber);
      append('category', form.category);
      append('severity', form.severity);
      append('postId', form.postId);
      append('occurredAt', new Date().toISOString());
      append('locationText', form.locationText);
      append('whatHappened', form.whatHappened.trim());
      append('resolution', form.resolution);
      append('otherDetails', form.otherDetails);
      append('peopleInvolved', form.peopleInvolved);
      append('peopleNotified', form.peopleNotified);
      if (form.policeNotified) fd.append('policeNotified', 'true');
      append('policeReportNumber', form.policeReportNumber);
      if (form.costRecovery !== '') fd.append('costRecovery', String(Number(form.costRecovery)));

      photos.forEach((p, i) => {
        // React Native's FormData takes a {uri, name, type} descriptor.
        fd.append('photos', {
          uri: p.uri,
          name: p.fileName || `incident-${Date.now()}-${i}.jpg`,
          type: p.mimeType || 'image/jpeg',
        });
      });

      const res = await api.upload('/incidents', fd);
      notify(`Report ${res.refNumber} submitted.`, 'ok');
      setTimeout(() => router.back(), 700);
    } catch (err) {
      setErrors(err.fieldErrors || {});
      notify(err.message, 'err');
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={S.content} keyboardShouldPersistTaps="handled">
        <Banner tone="info">
          Write it as the client will read it: facts, times, and what you did.
        </Banner>

        <Card title="Reporting officer">
          <View style={S.cardPad}>
            <Field label="Officer name">
              <Input value={form.officerName} onChangeText={set('officerName')} />
            </Field>
            <Field label="Callback number">
              <Input value={form.callbackNumber} onChangeText={set('callbackNumber')} keyboardType="phone-pad" />
            </Field>
          </View>
        </Card>

        <Card title="The incident">
          <View style={S.cardPad}>
            <Field label="Category">
              <ChipPicker options={INCIDENT_CATEGORIES} value={form.category} onChange={set('category')} allowEmpty />
            </Field>

            <Field label="Severity" hint="High or critical pages a supervisor.">
              <ChipPicker options={INCIDENT_SEVERITY} value={form.severity} onChange={set('severity')} />
            </Field>

            {posts.length > 0 && (
              <Field label="Post">
                <View style={[S.row, S.wrap, { gap: 7 }]}>
                  {posts.map((p) => {
                    const active = form.postId === p.id;
                    return (
                      <Pressable key={p.id} onPress={() => set('postId')(active ? null : p.id)}>
                        <View
                          style={[
                            S.chip,
                            { paddingVertical: 7, paddingHorizontal: 12 },
                            active && { backgroundColor: C.navy800 },
                          ]}
                        >
                          <Text style={[S.chipText, active && { color: '#fff' }]}>{p.name}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </Field>
            )}

            <Field label="Where exactly?" hint="Floor, door, camera, bay number.">
              <Input
                value={form.locationText}
                onChangeText={set('locationText')}
                placeholder="e.g. North stairwell, level 2"
              />
            </Field>

            <Field label="What happened?" error={errors.whatHappened} required>
              <Input
                value={form.whatHappened}
                onChangeText={set('whatHappened')}
                multiline
                error={!!errors.whatHappened}
                style={{ height: 120, textAlignVertical: 'top' }}
                placeholder="Describe what you saw and heard, in order, with times."
              />
            </Field>

            <Field label="How was it resolved?">
              <Input
                value={form.resolution}
                onChangeText={set('resolution')}
                multiline
                style={{ height: 90, textAlignVertical: 'top' }}
              />
            </Field>

            <Field label="Other details">
              <Input
                value={form.otherDetails}
                onChangeText={set('otherDetails')}
                multiline
                style={{ height: 70, textAlignVertical: 'top' }}
              />
            </Field>
          </View>
        </Card>

        <Card title="People & notifications">
          <View style={S.cardPad}>
            <Field label="People involved" hint="Names, or descriptions if unknown.">
              <Input value={form.peopleInvolved} onChangeText={set('peopleInvolved')} />
            </Field>
            <Field label="People notified" hint="Client contact, dispatch, supervisor.">
              <Input value={form.peopleNotified} onChangeText={set('peopleNotified')} />
            </Field>

            <View style={S.rowBetween}>
              <Text style={S.small}>Law enforcement was contacted</Text>
              <Switch
                value={form.policeNotified}
                onValueChange={set('policeNotified')}
                trackColor={{ true: C.brand400 }}
                thumbColor={form.policeNotified ? C.brand600 : undefined}
              />
            </View>

            {form.policeNotified && (
              <Field label="Police report number">
                <Input value={form.policeReportNumber} onChangeText={set('policeReportNumber')} />
              </Field>
            )}

            <Field label="Cost recovery (optional)" hint="Client-estimated value of damage or loss.">
              <Input
                value={form.costRecovery}
                onChangeText={set('costRecovery')}
                keyboardType="decimal-pad"
                placeholder="0.00"
              />
            </Field>
          </View>
        </Card>

        <Card title={`Photos (${photos.length}/${MAX_PHOTOS})`}>
          <View style={S.cardPad}>
            <View style={[S.row, S.wrap, { gap: 8 }]}>
              {photos.map((p, i) => (
                <Pressable key={i} onPress={() => setPhotos((list) => list.filter((_, idx) => idx !== i))}>
                  <Image
                    source={{ uri: p.uri }}
                    style={{ width: 84, height: 84, borderRadius: 10, backgroundColor: C.surface3 }}
                  />
                  <View
                    style={{
                      position: 'absolute', top: 4, right: 4,
                      backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10,
                      width: 20, height: 20, alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>×</Text>
                  </View>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button title="Take photo" variant="navy" onPress={() => addPhoto(true)} style={S.grow} />
              <Button title="From library" variant="ghost" onPress={() => addPhoto(false)} style={S.grow} />
            </View>
          </View>
        </Card>

        <Banner tone="info">
          Once submitted a report cannot be edited. A supervisor can add review notes.
        </Banner>

        <Button title="Submit report" variant="primary" onPress={submit} busy={busy} />
        <Button title="Cancel" variant="ghost" onPress={() => router.back()} disabled={busy} />
      </ScrollView>
      <Toast toast={toast} />
    </KeyboardAvoidingView>
  );
}
