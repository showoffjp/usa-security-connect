import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import { Chip, Empty, Field, Icon, LoadingPage, Modal, Stat, useToast } from '../../components/ui.jsx';
import { FUEL_LEVELS, VEHICLE_CHECK_LABEL } from '@shared/domain.js';

const mi = (n) => (n == null ? '--' : `${Number(n).toLocaleString()} mi`);
const KIND_LABEL = { start: 'Start check', end: 'End check', service: 'Service' };

/** How a vehicle stands, worst first: off the road, then signed out, then in the yard. */
function VehicleStatus({ v }) {
  if (v.off_road) return <Chip kind="danger">Off the road</Chip>;
  if (v.holder) {
    return (
      <span className="row wrap" style={{ gap: 6 }}>
        <Chip kind="brand">Out with {v.holder.name}</Chip>
        {v.uninspected && <Chip kind={v.uninspected_overdue ? 'danger' : 'warn'}>Not checked</Chip>}
      </span>
    );
  }
  if (v.status === 'maintenance') return <Chip kind="warn">In maintenance</Chip>;
  return <Chip kind="ok">In the yard</Chip>;
}

function ServiceChip({ v }) {
  if (v.service.state === 'overdue') return <Chip kind="danger">{mi(-v.service.milesLeft)} overdue</Chip>;
  if (v.service.state === 'due') return <Chip kind="warn">Due in {mi(v.service.milesLeft)}</Chip>;
  if (v.service.state === 'ok') return <span className="small muted">in {mi(v.service.milesLeft)}</span>;
  return <span className="small muted">--</span>;
}

/** Sign one defect off, saying what was done. */
function ResolveDefect({ defect, onDone }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/vehicles/defects/${defect.id}/resolve`, { resolution: text });
      toast.success(r.offRoad ? 'Signed off. Another fault still keeps it off the road.' : 'Signed off.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label={`Sign off ${defect.label}`}>
        <Icon name="check" size={14} /> Sign off the repair
      </button>
    );
  }
  return (
    <div className="row wrap" style={{ gap: 8, width: '100%' }}>
      <Field label="What was repaired">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Brake fluid leak repaired, road-tested" />
      </Field>
      <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || text.trim().length < 3}>
        {busy ? 'Saving...' : 'Sign off'}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

function RecordService({ vehicle, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ odometer: vehicle.odometer != null ? String(vehicle.odometer) : '', notes: '', nextDueMiles: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const r = await api.post(`/vehicles/${vehicle.id}/service`, {
        odometer: Number(form.odometer),
        notes: form.notes,
        nextDueMiles: form.nextDueMiles ? Number(form.nextDueMiles) : undefined,
      });
      toast.success(`Service recorded. Next one at ${mi(r.service_due_miles)}.`);
      setForm((f) => ({ ...f, notes: '', nextDueMiles: '' }));
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="grid grid-2">
        <Field label="Odometer at the service (miles)" error={errors.odometer} required>
          <input type="number" inputMode="numeric" min="0" value={form.odometer} onChange={set('odometer')} />
        </Field>
        <Field label="Next service due at (miles)" error={errors.nextDueMiles} hint="Leave blank for 5,000 miles on.">
          <input type="number" inputMode="numeric" min="0" value={form.nextDueMiles} onChange={set('nextDueMiles')} />
        </Field>
      </div>
      <Field label="What was done" error={errors.notes} required>
        <input value={form.notes} onChange={set('notes')} maxLength={500} placeholder="Oil and filter, tyre rotation" />
      </Field>
      <div>
        <button className="btn btn-navy btn-sm" onClick={save} disabled={busy || !form.odometer || form.notes.trim().length < 3}>
          <Icon name="check" size={14} /> {busy ? 'Saving...' : 'Record the service'}
        </button>
      </div>
    </div>
  );
}

function VehicleDetail({ id, onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/vehicles/${id}`));
    } catch (err) {
      toast.error(err.message);
      onClose();
    }
  }, [id, toast, onClose]);
  useEffect(() => {
    load();
  }, [load]);
  const changed = () => {
    load();
    onChanged();
  };

  if (!data) {
    return (
      <Modal title="Vehicle" onClose={onClose} wide>
        <div className="muted small">Loading...</div>
      </Modal>
    );
  }
  const v = data.vehicle;
  const open = data.defects.filter((d) => !d.resolved_at);
  const fixed = data.defects.filter((d) => d.resolved_at);
  const miles = data.trips.reduce((n, t) => n + t.miles, 0);

  return (
    <Modal title={v.label} onClose={onClose} wide>
      <div className="stack">
        <div className="row wrap" style={{ gap: 10 }}>
          <VehicleStatus v={v} />
          <span className="small muted">
            {v.identifier} &middot; {v.site_name || 'Company pool'} &middot; odometer {mi(v.odometer)} &middot; next service <ServiceChip v={v} />
          </span>
        </div>

        <section aria-labelledby="defects-h">
          <h3 id="defects-h" className="small strong" style={{ margin: '4px 0 8px' }}>
            Open defects
          </h3>
          {open.length === 0 ? (
            <div className="small muted">Nothing outstanding.</div>
          ) : (
            <ul className="list">
              {open.map((d) => (
                <li key={d.id} className="list-item" style={{ cursor: 'default', flexWrap: 'wrap' }}>
                  <div className="grow" style={{ minWidth: 220 }}>
                    <div className="small strong">
                      {d.label} {d.critical ? <Chip kind="danger">Off the road</Chip> : <Chip kind="warn">Minor</Chip>}
                    </div>
                    <div className="tiny muted">
                      {d.note || 'No note'} &middot; {d.reported_by || 'Unknown'}, {fmtRelative(d.reported_at)}
                    </div>
                  </div>
                  <ResolveDefect defect={d} onDone={changed} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="service-h">
          <h3 id="service-h" className="small strong" style={{ margin: '4px 0 8px' }}>
            Record a service
          </h3>
          <RecordService vehicle={v} onDone={changed} />
        </section>

        <section aria-labelledby="log-h">
          <h3 id="log-h" className="small strong" style={{ margin: '4px 0 8px' }}>
            Checks and services
          </h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Who</th>
                  <th>Odometer</th>
                  <th>Fuel</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.inspections.map((i) => (
                  <tr key={i.id}>
                    <td className="nowrap">{fmtDateTime(i.created_at)}</td>
                    <td>{KIND_LABEL[i.kind] || i.kind}</td>
                    <td>{i.officer || '--'}</td>
                    <td className="nowrap">{mi(i.odometer)}</td>
                    <td>{i.fuel_level == null ? '--' : FUEL_LEVELS[i.fuel_level]}</td>
                    <td>
                      {i.kind === 'service' ? (
                        <span className="small">{i.notes}</span>
                      ) : i.failed.length ? (
                        <span className="small">
                          <Chip kind="danger">{i.failed.map((k) => VEHICLE_CHECK_LABEL[k] || k).join(', ')}</Chip>
                          {i.notes ? <span className="muted"> {i.notes}</span> : null}
                        </span>
                      ) : (
                        <Chip kind="ok">All clear</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="trips-h">
          <h3 id="trips-h" className="small strong" style={{ margin: '4px 0 8px' }}>
            Trips in the last 30 days: {data.trips.length}, {mi(miles)}
          </h3>
          {data.trips.length === 0 ? (
            <div className="small muted">No completed trips.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Out</th>
                    <th>Back</th>
                    <th>Miles</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trips.slice(0, 15).map((t) => (
                    <tr key={t.id}>
                      <td>{t.officer}</td>
                      <td className="nowrap">{fmtDateTime(t.started_at)}</td>
                      <td className="nowrap">{fmtDateTime(t.ended_at)}</td>
                      <td>{mi(t.miles)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {fixed.length > 0 && (
          <details className="small">
            <summary style={{ cursor: 'pointer' }}>Signed-off defects ({fixed.length})</summary>
            <ul className="list">
              {fixed.map((d) => (
                <li key={d.id} className="list-item" style={{ cursor: 'default' }}>
                  <div className="grow">
                    <div className="small strong">{d.label}</div>
                    <div className="tiny muted">
                      {d.resolution} &middot; {d.resolved_by || 'Unknown'}, {fmtDateTime(d.resolved_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

export default function FleetPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const openId = Number(params.get('vehicle')) || null;

  const load = useCallback(async () => {
    try {
      setData(await api.get('/vehicles'));
    } catch (err) {
      toast.error(err.message);
      setData({ vehicles: [], summary: {} });
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const close = useCallback(() => setParams({}, { replace: true }), [setParams]);
  if (!data) return <LoadingPage label="Loading the fleet" />;
  const { vehicles, summary } = data;

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">Operations</div>
        <h1>Fleet</h1>
        <p className="lead">
          Patrol vehicles: who has each one, whether it was checked before it went out, what is wrong with it and when it is
          due a service. Miles come from the odometer readings at each check.
        </p>
      </div>

      <div className="grid grid-4">
        <Stat label="Vehicles" value={summary.total ?? 0} foot={`${summary.out ?? 0} out on patrol`} />
        <Stat label="Off the road" value={summary.offRoad ?? 0} foot="A failed safety check" alert={summary.offRoad > 0} />
        <Stat label="Service due" value={summary.serviceDue ?? 0} foot="Due or overdue by the odometer" alert={summary.serviceDue > 0} />
        <Stat label="Not checked" value={summary.uninspected ?? 0} foot="Signed out, no start check" alert={summary.uninspected > 0} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="h3">Vehicles</h2>
          <Link className="small" to="/admin/reports?report=vehicle-mileage">
            Mileage report
          </Link>
        </div>
        {vehicles.length === 0 ? (
          <Empty icon="car" title="No patrol vehicles">
            Add a vehicle under Keys &amp; equipment to start logging its checks and miles.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Status</th>
                  <th>Last check</th>
                  <th>Odometer</th>
                  <th>Next service</th>
                  <th>Miles, 7 / 30 days</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <div className="strong small">{v.label}</div>
                      <div className="tiny muted">
                        {v.identifier} &middot; {v.site_name || 'Company pool'}
                      </div>
                    </td>
                    <td>
                      <VehicleStatus v={v} />
                      {v.defects.length > 0 && (
                        <div className="tiny muted" style={{ marginTop: 4 }}>
                          {v.defects.length} open defect{v.defects.length === 1 ? '' : 's'}
                        </div>
                      )}
                    </td>
                    <td>
                      {v.last_inspection ? (
                        <>
                          <div className="small">
                            {KIND_LABEL[v.last_inspection.kind]}{' '}
                            {v.last_inspection.failed.length ? <Chip kind="danger">Failed</Chip> : null}
                          </div>
                          <div className="tiny muted">
                            {v.last_inspection.officer || '--'}, {fmtRelative(v.last_inspection.created_at)}
                          </div>
                        </>
                      ) : (
                        <span className="small muted">Never</span>
                      )}
                    </td>
                    <td className="nowrap">{mi(v.odometer)}</td>
                    <td className="nowrap">
                      <ServiceChip v={v} />
                    </td>
                    <td className="nowrap">
                      {mi(v.miles_7d)} / {mi(v.miles_30d)}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setParams({ vehicle: String(v.id) })} aria-label={`Open ${v.label}`}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openId && <VehicleDetail id={openId} onClose={close} onChanged={load} />}
    </div>
  );
}
