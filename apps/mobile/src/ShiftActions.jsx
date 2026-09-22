import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDay, fmtRange, fmtRelative } from './format.js';
import { Card, Chip, StatusChip, Button, Banner, Empty, Sheet, Field, Input, Loading } from './ui.jsx';
import { C, S } from './theme.js';

/* ======================================================== open shifts === */

/**
 * Shifts nobody is covering.
 *
 * The API works out eligibility per officer, so anything they cannot take is
 * shown greyed with the reason rather than hidden - an officer who does not
 * know why a shift is unavailable will simply ring the office.
 */
export function OpenShifts({ notify, onChanged }) {
  const [shifts, setShifts] = useState(null);
  const [claiming, setClaiming] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setShifts((await api.get('/shifts/open')).shifts);
    } catch (err) {
      notify?.(err.message, 'err');
      setShifts([]);
    }
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  const claim = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/shifts/${claiming.id}/claim`, { note: note.trim() || undefined });
      const advisory = res.advisories?.[0];
      notify?.(
        advisory
          ? `Asked for the shift. Note: ${advisory.message}`
          : 'Asked for the shift. Your supervisor will confirm.',
        'ok'
      );
      setClaiming(null);
      setNote('');
      await load();
      onChanged?.();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!shifts) return <Loading label="Finding open shifts" />;

  return (
    <>
      <Card title="Open shifts" right={<Chip tone={shifts.length ? 'brand' : 'plain'}>{shifts.length}</Chip>}>
        {shifts.length === 0 ? (
          <Empty title="Nothing open right now">
            Shifts nobody is covering show up here for you to pick up.
          </Empty>
        ) : (
          shifts.map((s, i) => {
            const blocking = s.eligibility.filter((r) => !r.advisory);
            const advisory = s.eligibility.filter((r) => r.advisory);
            return (
              <View
                key={s.id}
                style={[
                  S.listItem,
                  i === shifts.length - 1 && { borderBottomWidth: 0 },
                  blocking.length > 0 && { opacity: 0.6 },
                ]}
              >
                <View style={S.grow}>
                  <View style={[S.row, S.wrap, { gap: 6 }]}>
                    <Text style={[S.small, S.strong]}>{s.post_name}</Text>
                    {!!s.armed && <Chip tone="danger">Armed</Chip>}
                    {s.claim_count > 1 && <Chip tone="warn">{s.claim_count} asked</Chip>}
                  </View>
                  <Text style={S.tiny}>{s.site_name}</Text>
                  <Text style={[S.small, { marginTop: 2 }]}>
                    {fmtDay(s.starts_at)} · {fmtRange(s.starts_at, s.ends_at)}
                  </Text>

                  {blocking.map((r, idx) => (
                    <Text key={idx} style={[S.tiny, { color: C.danger, marginTop: 2 }]}>
                      {r.message}
                    </Text>
                  ))}
                  {advisory.map((r, idx) => (
                    <Text key={idx} style={[S.tiny, { color: C.warn, marginTop: 2 }]}>
                      {r.message}
                    </Text>
                  ))}
                </View>

                {s.already_requested ? (
                  <Chip tone="info">Asked</Chip>
                ) : s.canClaim ? (
                  <Button
                    title="Claim"
                    variant="primary"
                    onPress={() => setClaiming(s)}
                    style={{ paddingVertical: 9, paddingHorizontal: 14 }}
                  />
                ) : (
                  <Chip tone="plain">Not eligible</Chip>
                )}
              </View>
            );
          })
        )}
      </Card>

      <Sheet
        visible={!!claiming}
        title="Claim this shift?"
        onClose={() => {
          setClaiming(null);
          setNote('');
        }}
        footer={<Button title="Ask for this shift" variant="primary" busy={busy} onPress={claim} />}
      >
        {!!claiming && (
          <>
            <Banner tone="info" title={claiming.post_name}>
              {`${claiming.site_name}\n${fmtDay(claiming.starts_at)}, ${fmtRange(claiming.starts_at, claiming.ends_at)}`}
            </Banner>
            {claiming.claim_count > 0 && (
              <Banner tone="warn">
                {claiming.claim_count === 1
                  ? 'One other officer has already asked for this shift.'
                  : `${claiming.claim_count} other officers have already asked for this shift.`}
              </Banner>
            )}
            <Field label="Note for your supervisor" hint="Optional.">
              <Input
                value={note}
                onChangeText={setNote}
                multiline
                style={{ height: 80, textAlignVertical: 'top' }}
                placeholder="e.g. I can cover this, I am local to that site."
              />
            </Field>
          </>
        )}
      </Sheet>
    </>
  );
}

/* ==================================================== my requests ======= */

export function MyShiftRequests({ notify, onChanged }) {
  const [requests, setRequests] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequests((await api.get('/shifts/requests')).requests);
    } catch {
      setRequests([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const respond = async (request, accept) => {
    setBusy(true);
    try {
      await api.post(`/shifts/requests/${request.id}/respond`, { accept });
      notify?.(accept ? 'Accepted. Your supervisor will confirm.' : 'Declined.', 'ok');
      await load();
      onChanged?.();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (request) => {
    setBusy(true);
    try {
      await api.del(`/shifts/requests/${request.id}`);
      notify?.('Request withdrawn.', 'ok');
      await load();
      onChanged?.();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!requests || requests.length === 0) return null;

  return (
    <Card title="My requests">
      {requests.slice(0, 8).map((r, i) => {
        const needsMyAnswer = r.status === 'pending' && r.kind === 'swap' && r.target_name;
        return (
          <View key={r.id} style={[S.listItem, i === Math.min(requests.length, 8) - 1 && { borderBottomWidth: 0 }]}>
            <View style={S.grow}>
              <View style={[S.row, S.wrap, { gap: 6 }]}>
                <Text style={[S.small, S.strong]}>{r.label}</Text>
                <StatusChip value={r.status} />
              </View>
              <Text style={S.tiny}>
                {r.post_name} · {fmtDay(r.starts_at)} {fmtRange(r.starts_at, r.ends_at)}
              </Text>
              {!!r.decision_note && <Text style={S.tiny}>{r.decision_note}</Text>}
              <Text style={S.tiny}>{fmtRelative(r.created_at)}</Text>
            </View>

            {needsMyAnswer ? (
              <View style={{ gap: 6 }}>
                <Button
                  title="Accept"
                  variant="primary"
                  busy={busy}
                  onPress={() => respond(r, true)}
                  style={{ paddingVertical: 7, paddingHorizontal: 12 }}
                />
                <Button
                  title="Decline"
                  variant="ghost"
                  busy={busy}
                  onPress={() => respond(r, false)}
                  style={{ paddingVertical: 7, paddingHorizontal: 12 }}
                />
              </View>
            ) : ['pending', 'accepted'].includes(r.status) ? (
              <Pressable onPress={() => withdraw(r)} disabled={busy}>
                <Text style={[S.small, { color: C.muted, fontWeight: '700' }]}>Withdraw</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </Card>
  );
}

/* ================================================= swap / drop sheet ==== */

/** Offer a shift to a colleague, or ask to be taken off it. */
export function ShiftActionSheet({ shift, onClose, notify, onChanged }) {
  const [mode, setMode] = useState(null); // 'swap' | 'drop'
  const [contacts, setContacts] = useState([]);
  const [targetId, setTargetId] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'swap') return;
    api
      .get('/messages/contacts')
      .then((r) => setContacts(r.contacts.filter((c) => c.role === 'officer')))
      .catch(() => {});
  }, [mode]);

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'swap') {
        await api.post(`/shifts/${shift.id}/swap`, {
          targetUserId: targetId,
          note: text.trim() || undefined,
        });
        notify?.('Swap offered. They need to accept, then a supervisor confirms.', 'ok');
      } else {
        await api.post(`/shifts/${shift.id}/drop`, { reason: text.trim() });
        notify?.('Drop requested. Your supervisor will decide.', 'ok');
      }
      onChanged?.();
      onClose();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = mode === 'swap' ? Boolean(targetId) : text.trim().length >= 5;

  return (
    <Sheet
      visible={!!shift}
      title={mode ? (mode === 'swap' ? 'Offer this shift' : 'Ask to drop this shift') : 'Shift options'}
      onClose={() => {
        setMode(null);
        setTargetId(null);
        setText('');
        onClose();
      }}
      footer={
        mode ? (
          <>
            <Button title={mode === 'swap' ? 'Send offer' : 'Request drop'} variant="primary" busy={busy} disabled={!canSubmit} onPress={submit} />
            <Button title="Back" variant="ghost" onPress={() => setMode(null)} />
          </>
        ) : null
      }
    >
      {!!shift && (
        <Banner tone="info" title={shift.post_name}>
          {`${shift.site_name}\n${fmtDay(shift.starts_at)}, ${fmtRange(shift.starts_at, shift.ends_at)}`}
        </Banner>
      )}

      {!mode && (
        <View style={{ gap: 10 }}>
          <Button title="Offer it to another officer" variant="navy" onPress={() => setMode('swap')} />
          <Button title="Ask to be taken off it" variant="ghost" onPress={() => setMode('drop')} />
          <Text style={[S.tiny, { textAlign: 'center' }]}>
            Either way a supervisor has the final say, and the post stays covered until they decide.
          </Text>
        </View>
      )}

      {mode === 'swap' && (
        <>
          <Field label="Who should take it?" required>
            <View style={[S.row, S.wrap, { gap: 7 }]}>
              {contacts.map((c) => {
                const active = targetId === c.id;
                return (
                  <Pressable key={c.id} onPress={() => setTargetId(active ? null : c.id)}>
                    <View
                      style={[
                        S.chip,
                        { paddingVertical: 8, paddingHorizontal: 12 },
                        active && { backgroundColor: C.navy800 },
                      ]}
                    >
                      <Text style={[S.chipText, active && { color: '#fff' }]}>{c.name}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </Field>
          <Field label="Message" hint="Optional - why you are asking.">
            <Input
              value={text}
              onChangeText={setText}
              multiline
              style={{ height: 80, textAlignVertical: 'top' }}
            />
          </Field>
        </>
      )}

      {mode === 'drop' && (
        <Field label="Why do you need to drop it?" hint="Your supervisor sees this." required>
          <Input
            value={text}
            onChangeText={setText}
            multiline
            style={{ height: 100, textAlignVertical: 'top' }}
            placeholder="e.g. Court date I could not move."
          />
        </Field>
      )}
    </Sheet>
  );
}
