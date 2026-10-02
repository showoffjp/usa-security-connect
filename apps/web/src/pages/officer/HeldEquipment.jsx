import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';
import { Banner, Chip, Field, Icon, Modal, useToast } from '../../components/ui.jsx';
import { EQUIPMENT_CATEGORY_LABEL, FUEL_LEVELS, VEHICLE_CHECKS } from '@shared/domain.js';

const mi = (n) => (n == null ? '--' : `${Number(n).toLocaleString()} mi`);

/**
 * The walk-round check before driving a patrol vehicle, and again when it is
 * handed back. Every item has to be answered; anything marked as a problem
 * needs a note, and a safety item takes the vehicle off the road.
 */
export function VehicleCheck({ vehicle, kind, onClose, onDone }) {
  const toast = useToast();
  const [odometer, setOdometer] = useState('');
  const [fuel, setFuel] = useState(null);
  const [checks, setChecks] = useState({});
  const [notes, setNotes] = useState('');
  const [handBack, setHandBack] = useState(kind === 'end');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const failed = VEHICLE_CHECKS.filter((c) => checks[c.key] === 'fail');
  const answered = VEHICLE_CHECKS.every((c) => checks[c.key]);
  const ready = odometer !== '' && fuel != null && answered && (!failed.length || notes.trim().length >= 5);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const r = await api.post(`/vehicles/${vehicle.id}/inspections`, {
        kind,
        odometer: Number(odometer),
        fuelLevel: fuel,
        checks,
        notes: notes.trim() || undefined,
        returnVehicle: kind === 'end' ? handBack : undefined,
      });
      if (r.critical) toast.error('Recorded. Do not drive it: your supervisor has been told it is off the road.');
      else if (kind === 'end') toast.success(`Recorded${r.miles != null ? `: ${r.miles} miles this stretch` : ''}.${r.returned ? ' Vehicle handed back.' : ''}`);
      else toast.success('Checked. Drive safely.');
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={kind === 'start' ? 'Check before you drive' : 'End check'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>
            {busy ? 'Saving...' : kind === 'start' ? 'Save the check' : handBack ? 'Save and hand back' : 'Save the check'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          {vehicle.label} ({vehicle.identifier}). Last reading {mi(vehicle.odometer)}.
        </div>
        <div className="grid grid-2">
          <Field label="Odometer (miles)" required error={errors.odometer}>
            <input type="number" inputMode="numeric" min={vehicle.odometer ?? 0} value={odometer} onChange={(e) => setOdometer(e.target.value)} />
          </Field>
          <fieldset className="check-row plain">
            <legend className="small strong">Fuel</legend>
            <div className="row wrap" style={{ gap: 6 }}>
              {FUEL_LEVELS.map((label, i) => (
                <label key={label} className={`chip-toggle${fuel === i ? ' on' : ''}`}>
                  <input type="radio" name="fuel" className="sr-only" checked={fuel === i} onChange={() => setFuel(i)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          {VEHICLE_CHECKS.map((c) => (
            <fieldset key={c.key} className={`check-row${checks[c.key] === 'fail' ? ' failed' : ''}`}>
              <legend className="small">
                {c.label}
                {c.critical ? <span className="tiny muted"> · safety</span> : null}
              </legend>
              <div className="row" style={{ gap: 6 }}>
                {['ok', 'fail'].map((v) => (
                  <label key={v} className={`chip-toggle${checks[c.key] === v ? (v === 'ok' ? ' on' : ' bad') : ''}`}>
                    <input type="radio" name={`check-${c.key}`} className="sr-only" checked={checks[c.key] === v}
                      onChange={() => setChecks((all) => ({ ...all, [c.key]: v }))} />
                    {v === 'ok' ? 'OK' : 'Problem'}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>

        {failed.some((c) => c.critical) && (
          <Banner kind="danger" title="Do not drive this vehicle">
            <span className="small">A safety item has failed. It goes off the road until it is repaired.</span>
          </Banner>
        )}
        <Field label={failed.length ? 'What is wrong?' : 'Notes'} required={failed.length > 0} error={errors.notes}
          hint={failed.length ? 'So the workshop knows what to look at.' : 'Optional.'}>
          <textarea rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {kind === 'end' && (
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={handBack} onChange={(e) => setHandBack(e.target.checked)} />
            Hand the vehicle back now
          </label>
        )}
      </div>
    </Modal>
  );
}

function ReturnItem({ item, onClose, onDone }) {
  const toast = useToast();
  const [condition, setCondition] = useState('good');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/equipment/mine/${item.id}/return`, { condition, note: note.trim() || null });
      toast.success(`${item.label} handed back.`);
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Hand back ${item.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving...' : 'Hand it back'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Condition">
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="good">Good</option>
            <option value="worn">Worn</option>
            <option value="damaged">Damaged</option>
          </select>
        </Field>
        <Field label="Note" hint="Optional. Anything the next person should know.">
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** What the officer has signed out: keys, radios, a firearm, a patrol vehicle and its checks. */
export default function HeldEquipment() {
  const [data, setData] = useState(null);
  const [checking, setChecking] = useState(null);
  const [returning, setReturning] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get('/equipment/mine'));
    } catch {
      setData({ held: [], vehicles: [] });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (!data || data.held.length === 0) return null;
  const vehicles = new Map((data.vehicles || []).map((v) => [v.id, v]));
  const needsCheck = (data.vehicles || []).some((v) => v.uninspected);

  return (
    <div className={`card${needsCheck ? ' attention' : ''}`} id="held-equipment">
      <div className="card-head">
        <div className="row">
          <Icon name="clipboard" size={18} style={{ color: 'var(--brand-text)' }} />
          <h3>Signed out to you</h3>
        </div>
        {data.mustReturnBeforeClockOut > 0 && <span className="tiny muted">Hand back before you clock out</span>}
      </div>
      <ul className="list">
        {data.held.map((h) => {
          const v = vehicles.get(h.id);
          return (
            <li key={h.id} className="list-item" style={{ cursor: 'default', flexWrap: 'wrap' }}>
              <div className="lead-icon">
                <Icon name={h.category === 'vehicle' ? 'car' : 'clipboard'} size={17} />
              </div>
              <div className="grow">
                <div className="small strong">{h.label}</div>
                <div className="tiny muted">
                  {EQUIPMENT_CATEGORY_LABEL[h.category] || h.category} &middot; since {fmtRelative(h.issued_at)}
                  {v ? ` · ${mi(v.odometer)}` : ''}
                </div>
                {v?.off_road && <div className="tiny" style={{ color: 'var(--danger)' }}>Off the road: do not drive it.</div>}
              </div>
              <div className="row wrap list-trailing" style={{ gap: 6, justifyContent: 'flex-end' }}>
                {v ? (
                  v.uninspected ? (
                    <>
                      <Chip kind="warn">Not checked</Chip>
                      <button className="btn btn-primary btn-sm" onClick={() => setChecking({ vehicle: v, kind: 'start' })}>
                        <Icon name="check" size={14} /> Check before driving
                      </button>
                    </>
                  ) : (
                    <>
                      <Chip kind="ok">Checked {fmtRelative(v.start_inspection.created_at)}</Chip>
                      <button className="btn btn-ghost btn-sm" onClick={() => setChecking({ vehicle: v, kind: 'end' })}>
                        End check and hand back
                      </button>
                    </>
                  )
                ) : (
                  <button className="btn btn-ghost btn-sm" onClick={() => setReturning(h)} aria-label={`Hand back ${h.label}`}>
                    Hand back
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {checking && (
        <VehicleCheck
          vehicle={checking.vehicle}
          kind={checking.kind}
          onClose={() => setChecking(null)}
          onDone={() => {
            setChecking(null);
            load();
          }}
        />
      )}
      {returning && (
        <ReturnItem
          item={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            load();
          }}
        />
      )}
    </div>
  );
}
