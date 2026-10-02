import { useCallback, useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { api } from './api.js';
import { fmtRelative } from './format.js';
import { EQUIPMENT_CATEGORY_LABEL, FUEL_LEVELS, VEHICLE_CHECKS } from './shared.js';
import { Banner, Button, Card, Chip, Field, Input, Sheet } from './ui.jsx';
import { C, S } from './theme.js';

const mi = (n) => (n == null ? '--' : `${Number(n).toLocaleString()} mi`);

/** A row of pill buttons, one of which can be picked. */
function Pick({ options, value, onChange, label, bad }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = value === o.value;
        const isBad = on && bad?.(o.value);
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${label}: ${o.label}`}
            style={{
              paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1,
              borderColor: isBad ? C.danger : on ? C.ok : C.line,
              backgroundColor: isBad ? C.dangerBg : on ? C.okBg : C.surface,
            }}
          >
            <Text style={{ fontWeight: '700', color: isBad ? C.danger : on ? C.ok : C.ink }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The walk-round check before driving, and again when handing the vehicle back. */
function VehicleCheck({ vehicle, kind, onClose, onDone, notify }) {
  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState(null);
  const [checks, setChecks] = useState({});
  const [notes, setNotes] = useState('');
  const [handBack, setHandBack] = useState(kind === 'end');
  const [busy, setBusy] = useState(false);
  const failed = VEHICLE_CHECKS.filter((c) => checks[c.key] === 'fail');
  const ready = odometer !== '' && fuel != null && VEHICLE_CHECKS.every((c) => checks[c.key]) && (!failed.length || notes.trim().length >= 5);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/vehicles/${vehicle.id}/inspections`, {
        kind,
        odometer: Number(odometer),
        fuelLevel: fuel,
        checks,
        notes: notes.trim() || undefined,
        returnVehicle: kind === 'end' ? handBack : undefined,
      });
      if (r.critical) notify('Recorded. Do not drive it: your supervisor has been told.', 'err');
      else notify(kind === 'end' ? `Recorded${r.miles != null ? `: ${r.miles} miles` : ''}.${r.returned ? ' Vehicle handed back.' : ''}` : 'Checked. Drive safely.', 'ok');
      onDone();
    } catch (err) {
      notify(err.message, 'err');
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible
      title={kind === 'start' ? 'Check before you drive' : 'End check'}
      onClose={onClose}
      footer={<Button variant="primary" title={kind === 'end' && handBack ? 'Save and hand back' : 'Save the check'} busy={busy} disabled={!ready} onPress={save} />}
    >
      <Text style={S.small}>{`${vehicle.label} (${vehicle.identifier}). Last reading ${mi(vehicle.odometer)}.`}</Text>
      <Field label="Odometer (miles)" required>
        <Input value={odometer} onChangeText={(t) => setOdometer(t.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder={vehicle.odometer != null ? String(vehicle.odometer) : ''} />
      </Field>
      <Field label="Fuel">
        <Pick label="Fuel" value={fuel} onChange={setFuel} options={FUEL_LEVELS.map((l, i) => ({ value: i, label: l }))} />
      </Field>
      {VEHICLE_CHECKS.map((c) => (
        <View key={c.key} style={{ gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: checks[c.key] === 'fail' ? C.danger : C.line, backgroundColor: checks[c.key] === 'fail' ? C.dangerBg : 'transparent' }}>
          <Text style={[S.small, S.strong]}>
            {c.label}
            {c.critical ? <Text style={S.tiny}>  · safety</Text> : null}
          </Text>
          <Pick label={c.label} value={checks[c.key]} bad={(v) => v === 'fail'} onChange={(v) => setChecks((all) => ({ ...all, [c.key]: v }))}
            options={[{ value: 'ok', label: 'OK' }, { value: 'fail', label: 'Problem' }]} />
        </View>
      ))}
      {failed.some((c) => c.critical) && (
        <Banner tone="danger" title="Do not drive this vehicle">
          A safety item has failed. It goes off the road until it is repaired.
        </Banner>
      )}
      <Field label={failed.length ? 'What is wrong?' : 'Notes'} required={failed.length > 0} hint={failed.length ? 'So the workshop knows what to look at.' : 'Optional.'}>
        <Input value={notes} onChangeText={setNotes} multiline maxLength={500} style={{ minHeight: 64, textAlignVertical: 'top' }} />
      </Field>
      {kind === 'end' && (
        <View style={[S.rowBetween, { gap: 10 }]}>
          <Text style={S.small}>Hand the vehicle back now</Text>
          <Switch value={handBack} onValueChange={setHandBack} accessibilityLabel="Hand the vehicle back now" />
        </View>
      )}
    </Sheet>
  );
}

/** What the officer has signed out, with a patrol vehicle's checks. */
export function HeldEquipment({ notify, refreshKey }) {
  const [data, setData] = useState(null);
  const [checking, setChecking] = useState(null);
  const load = useCallback(() => {
    api.get('/equipment/mine').then(setData, () => setData({ held: [], vehicles: [] }));
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (!data || !data.held.length) return null;
  const vehicles = new Map((data.vehicles || []).map((v) => [v.id, v]));

  return (
    <>
      <Card title="Signed out to you" right={data.mustReturnBeforeClockOut ? <Text style={S.tiny}>Hand back before clock-out</Text> : null}>
        {data.held.map((h, i) => {
          const v = vehicles.get(h.id);
          return (
            <View key={h.id} style={{ padding: 14, gap: 6, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
              <Text style={{ fontWeight: '700', color: C.ink }}>{h.label}</Text>
              <Text style={S.tiny}>
                {`${EQUIPMENT_CATEGORY_LABEL[h.category] || h.category} · since ${fmtRelative(h.issued_at)}${v ? ` · ${mi(v.odometer)}` : ''}`}
              </Text>
              {v?.off_road && <Chip tone="danger">Off the road: do not drive</Chip>}
              {v ? (
                v.uninspected ? (
                  <>
                    <Chip tone="warn">Not checked</Chip>
                    <Button variant="primary" title="Check before driving" onPress={() => setChecking({ vehicle: v, kind: 'start' })} />
                  </>
                ) : (
                  <>
                    <Chip tone="ok">{`Checked ${fmtRelative(v.start_inspection.created_at)}`}</Chip>
                    <Button title="End check and hand back" onPress={() => setChecking({ vehicle: v, kind: 'end' })} />
                  </>
                )
              ) : (
                <Text style={S.tiny}>Hand it to your supervisor, or back at the counter.</Text>
              )}
            </View>
          );
        })}
      </Card>
      {!!checking && (
        <VehicleCheck
          vehicle={checking.vehicle}
          kind={checking.kind}
          notify={notify}
          onClose={() => setChecking(null)}
          onDone={() => {
            setChecking(null);
            load();
          }}
        />
      )}
    </>
  );
}
