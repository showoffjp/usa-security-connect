import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { api } from '../src/api.js';
import { fmtTime, fmtRelative } from '../src/format.js';
import {
  Banner, Button, Card, Chip, Empty, Field, Input, Loading, Segmented, Sheet, Toast, useToastState,
} from '../src/ui.jsx';
import { C, S } from '../src/theme.js';

const WATCH_ACTION = {
  deny_entry: 'Do not let them in',
  call_police: 'Call the police',
  notify_supervisor: 'Call your supervisor',
  escort: 'Escort only',
};
const CATEGORIES = [
  { value: 'patrol', label: 'Patrol' },
  { value: 'observation', label: 'Seen' },
  { value: 'access', label: 'Access' },
  { value: 'alarm', label: 'Alarm' },
  { value: 'safety', label: 'Safety' },
];
const CATEGORY_LABEL = {
  patrol: 'Patrol', observation: 'Observation', access: 'Access', alarm: 'Alarm', safety: 'Safety',
  customer_service: 'Customer service', other: 'Other',
};

const blankVisitor = { fullName: '', purpose: '', company: '', host: '', vehiclePlate: '' };

/**
 * Sign a visitor in. The server checks every name and plate against the
 * site's watchlist; a match stops the sign-in and shows the entry, and the
 * officer can only let the person in by naming the entry and saying why.
 */
function SignInSheet({ visible, onClose, onDone, notify }) {
  const [form, setForm] = useState(blankVisitor);
  const [errors, setErrors] = useState({});
  const [matches, setMatches] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => {
    setForm(blankVisitor);
    setErrors({});
    setMatches(null);
    setReason('');
  };
  const close = () => {
    reset();
    onClose();
  };

  const submit = async (override) => {
    setBusy(true);
    setErrors({});
    try {
      await api.post('/post-log/visitors', {
        fullName: form.fullName,
        purpose: form.purpose,
        company: form.company || null,
        host: form.host || null,
        vehiclePlate: form.vehiclePlate || null,
        override: override || null,
      });
      notify(`${form.fullName} signed in.`, 'ok');
      reset();
      onDone();
    } catch (err) {
      if (err.status === 409 && err.details?.code === 'watchlist_match') {
        setMatches(err.details.matches);
      } else {
        setErrors(err.fieldErrors || {});
        notify(err.message, 'err');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title={matches ? 'Watchlist match' : 'Sign someone in'}
      onClose={close}
      footer={
        matches ? (
          <>
            <Button
              title="Let them in anyway"
              variant="danger"
              busy={busy}
              disabled={reason.trim().length < 5}
              onPress={() => submit({ watchlistId: matches[0].id, reason })}
            />
            <Button title="Do not sign them in" onPress={close} />
          </>
        ) : (
          <Button
            title="Sign in"
            variant="primary"
            busy={busy}
            disabled={form.fullName.trim().length < 2 || form.purpose.trim().length < 2}
            onPress={() => submit(null)}
          />
        )
      }
    >
      {matches ? (
        <>
          {matches.map((m) => (
            <Banner key={m.id} tone="danger" title={`${m.full_name}: ${WATCH_ACTION[m.action] || m.action}`}>
              {[m.reason, m.description, m.vehicle_plate ? `Vehicle ${m.vehicle_plate}` : null].filter(Boolean).join('\n')}
            </Banner>
          ))}
          <Text style={S.small}>
            Follow the instruction above. If this is someone else with the same name, say how you know - your
            supervisor reads it.
          </Text>
          <Field label="Why they are being let in" required>
            <Input value={reason} onChangeText={setReason} placeholder="e.g. Checked ID: different date of birth" multiline />
          </Field>
        </>
      ) : (
        <>
          <Field label="Full name" required error={errors.fullName}>
            <Input value={form.fullName} onChangeText={set('fullName')} autoCapitalize="words" error={errors.fullName} />
          </Field>
          <Field label="Here for" required error={errors.purpose}>
            <Input value={form.purpose} onChangeText={set('purpose')} placeholder="Meeting, delivery, repair..." error={errors.purpose} />
          </Field>
          <Field label="Company">
            <Input value={form.company} onChangeText={set('company')} />
          </Field>
          <Field label="Visiting">
            <Input value={form.host} onChangeText={set('host')} placeholder="Tenant or person" />
          </Field>
          <Field label="Vehicle plate">
            <Input value={form.vehiclePlate} onChangeText={set('vehiclePlate')} autoCapitalize="characters" />
          </Field>
        </>
      )}
    </Sheet>
  );
}

function ActivitySheet({ visible, onClose, onDone, notify }) {
  const [category, setCategory] = useState('patrol');
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/post-log/activity', { category, body, clientVisible: !internal });
      notify('Logged.', 'ok');
      setBody('');
      setInternal(false);
      onDone();
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible={visible}
      title="Log activity"
      onClose={onClose}
      footer={<Button title="Save to the log" variant="primary" busy={busy} disabled={body.trim().length < 3} onPress={save} />}
    >
      <Segmented value={category} onChange={setCategory} options={CATEGORIES} />
      <Field label="What happened" required>
        <Input value={body} onChangeText={setBody} multiline style={{ minHeight: 96, textAlignVertical: 'top' }} />
      </Field>
      <View style={S.rowBetween}>
        <View style={S.grow}>
          <Text style={[S.small, S.strong, { color: C.ink }]}>Internal only</Text>
          <Text style={S.tiny}>Kept out of the client's daily report.</Text>
        </View>
        <Switch value={internal} onValueChange={setInternal} accessibilityLabel="Internal only" />
      </View>
    </Sheet>
  );
}

/** The officer's post log: who is on site, and the shift's activity log. */
export default function PostLogScreen() {
  const [toast, setToast] = useToastState();
  const notify = (message, tone) => setToast({ message, tone });
  const [tab, setTab] = useState('visitors');
  const [log, setLog] = useState(null);
  const [site, setSite] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [logging, setLogging] = useState(false);
  const [leaving, setLeaving] = useState(null);

  const load = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([api.get('/post-log'), api.get('/post-log/site')]);
      setLog(l);
      setSite(s);
    } catch (err) {
      notify(err.message, 'err');
      setLog((x) => x || { post: null });
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const signOut = async (v) => {
    setLeaving(v.id);
    try {
      await api.post(`/post-log/visitors/${v.id}/depart`);
      notify(`${v.full_name} signed out.`, 'ok');
      load();
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setLeaving(null);
    }
  };

  if (!log) return <Loading label="Opening the post log" />;
  const onSite = log.visitors?.onSite || [];
  const activity = site?.activity || [];

  return (
    <View style={S.screen}>
      <ScrollView
        contentContainerStyle={S.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={C.brand600}
          />
        }
      >
        {!log.post ? (
          <Banner tone="info" title="Not on a post">
            The post log opens for the post you are on or about to start.
          </Banner>
        ) : (
          <>
            <View>
              <Text style={S.eyebrow}>{log.post.site_name}</Text>
              <Text style={S.h2}>{log.post.post_name}</Text>
            </View>
            {!log.onDuty && (
              <Banner tone="warn" title="You are not clocked in">
                You can read the log now; signing visitors in and logging activity start when you clock in.
              </Banner>
            )}
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'visitors', label: `On site (${onSite.length})` },
                { value: 'activity', label: `Activity (${activity.length})` },
              ]}
            />

            {tab === 'visitors' ? (
              <>
                {log.onDuty && <Button title="Sign someone in" variant="primary" onPress={() => setSigningIn(true)} />}
                <Card>
                  {onSite.length === 0 ? (
                    <Empty title="Nobody signed in">Visitors, contractors and deliveries you sign in appear here.</Empty>
                  ) : (
                    onSite.map((v, i) => (
                      <View
                        key={v.id}
                        style={[S.rowBetween, { padding: 14, gap: 10 }, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}
                      >
                        <View style={S.grow}>
                          <Text style={[S.small, S.strong, { color: C.ink }]}>{v.full_name}</Text>
                          <Text style={S.tiny}>
                            {[v.company, v.purpose].filter(Boolean).join(' · ')} · in {fmtTime(v.arrived_at)}
                            {v.vehicle_plate ? ` · ${v.vehicle_plate}` : ''}
                          </Text>
                          {!!v.watchlist_id && <Chip tone="danger">Watchlist override</Chip>}
                        </View>
                        {log.onDuty && (
                          <Button title="Sign out" onPress={() => signOut(v)} busy={leaving === v.id} style={{ paddingHorizontal: 12 }} />
                        )}
                      </View>
                    ))
                  )}
                </Card>
              </>
            ) : (
              <>
                {log.onDuty && <Button title="Log activity" variant="primary" onPress={() => setLogging(true)} />}
                <Card>
                  {activity.length === 0 ? (
                    <Empty title="Nothing logged in the last day">Patrols, alarms and anything you see go here.</Empty>
                  ) : (
                    activity.map((a, i) => (
                      <View key={a.id} style={[{ padding: 14, gap: 4 }, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
                        <View style={[S.row, { flexWrap: 'wrap', gap: 6 }]}>
                          <Chip tone="navy">{CATEGORY_LABEL[a.category] || a.category}</Chip>
                          {!a.client_visible && <Chip>Internal</Chip>}
                          <Text style={S.tiny}>
                            {fmtTime(a.occurred_at)} ({fmtRelative(a.occurred_at)}) · {a.officer_name}
                          </Text>
                        </View>
                        <Text style={[S.small, { lineHeight: 20 }]}>{a.body}</Text>
                      </View>
                    ))
                  )}
                </Card>
              </>
            )}
          </>
        )}
      </ScrollView>
      <SignInSheet
        visible={signingIn}
        notify={notify}
        onClose={() => setSigningIn(false)}
        onDone={() => {
          setSigningIn(false);
          load();
        }}
      />
      <ActivitySheet
        visible={logging}
        notify={notify}
        onClose={() => setLogging(false)}
        onDone={() => {
          setLogging(false);
          load();
        }}
      />
      <Toast toast={toast} />
    </View>
  );
}
