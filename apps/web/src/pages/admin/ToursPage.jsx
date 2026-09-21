import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Field, Segmented, useToast, Banner,
} from '../../components/ui.jsx';

/** Build a tour: checkpoints in order, each with its own task list. */
function TourBuilder({ sites, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [tour, setTour] = useState({
    siteId: String(sites[0]?.id || ''),
    name: '',
    description: '',
    expectedMinutes: 30,
    checkpoints: [{ name: '', nfcTagId: '', instructions: '', required: true, tasks: [''] }],
  });

  const setCp = (i, patch) =>
    setTour((t) => ({
      ...t,
      checkpoints: t.checkpoints.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    }));

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/admin/tours', {
        siteId: Number(tour.siteId),
        name: tour.name.trim(),
        description: tour.description || undefined,
        expectedMinutes: Number(tour.expectedMinutes) || null,
        checkpoints: tour.checkpoints
          .filter((c) => c.name.trim())
          .map((c) => ({
            name: c.name.trim(),
            nfcTagId: c.nfcTagId.trim() || undefined,
            instructions: c.instructions.trim() || undefined,
            required: c.required,
            tasks: c.tasks.filter((t) => t.trim()).map((label) => ({ label: label.trim(), required: true })),
          })),
      });
      toast.success('Tour created.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const valid = tour.name.trim().length > 1 && tour.checkpoints.some((c) => c.name.trim());

  return (
    <Modal
      title="Build a tour"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !valid}>Create tour</button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Site" required>
            <select value={tour.siteId} onChange={(e) => setTour((t) => ({ ...t, siteId: e.target.value }))}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Tour name" required>
            <input
              value={tour.name}
              onChange={(e) => setTour((t) => ({ ...t, name: e.target.value }))}
              placeholder="Interior Round"
            />
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="Description">
            <input value={tour.description} onChange={(e) => setTour((t) => ({ ...t, description: e.target.value }))} />
          </Field>
          <Field label="Expected minutes">
            <input
              type="number"
              min="1"
              value={tour.expectedMinutes}
              onChange={(e) => setTour((t) => ({ ...t, expectedMinutes: e.target.value }))}
            />
          </Field>
        </div>

        <fieldset>
          <legend>Checkpoints (walked in this order)</legend>
          <div className="stack">
            {tour.checkpoints.map((c, i) => (
              <div key={i} className="card card-pad stack" style={{ background: 'var(--surface-2)' }}>
                <div className="row-between">
                  <span className="strong small">Checkpoint {i + 1}</span>
                  {tour.checkpoints.length > 1 && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() =>
                        setTour((t) => ({ ...t, checkpoints: t.checkpoints.filter((_, idx) => idx !== i) }))
                      }
                    >
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </div>

                <div className="grid grid-2">
                  <Field label="Name">
                    <input value={c.name} onChange={(e) => setCp(i, { name: e.target.value })} placeholder="Loading Dock" />
                  </Field>
                  <Field label="NFC / QR tag ID" hint="Printed on the physical tag.">
                    <input value={c.nfcTagId} onChange={(e) => setCp(i, { nfcTagId: e.target.value })} placeholder="USC-NFC-..." />
                  </Field>
                </div>

                <Field label="Instructions">
                  <input value={c.instructions} onChange={(e) => setCp(i, { instructions: e.target.value })} />
                </Field>

                <Field label="Tasks at this checkpoint">
                  <div className="stack-sm">
                    {c.tasks.map((task, ti) => (
                      <div key={ti} className="row">
                        <input
                          className="grow"
                          value={task}
                          onChange={(e) =>
                            setCp(i, { tasks: c.tasks.map((t, idx) => (idx === ti ? e.target.value : t)) })
                          }
                          placeholder="e.g. Confirm dock doors are down"
                        />
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setCp(i, { tasks: c.tasks.filter((_, idx) => idx !== ti) })}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    ))}
                    <button className="btn btn-sm btn-ghost" onClick={() => setCp(i, { tasks: [...c.tasks, ''] })}>
                      <Icon name="plus" size={14} /> Add task
                    </button>
                  </div>
                </Field>

                <label className="check">
                  <input type="checkbox" checked={c.required} onChange={(e) => setCp(i, { required: e.target.checked })} />
                  <span>Required - the tour cannot be finished until this is scanned or skipped with a reason</span>
                </label>
              </div>
            ))}

            <button
              className="btn btn-ghost"
              onClick={() =>
                setTour((t) => ({
                  ...t,
                  checkpoints: [...t.checkpoints, { name: '', nfcTagId: '', instructions: '', required: true, tasks: [''] }],
                }))
              }
            >
              <Icon name="plus" size={16} /> Add checkpoint
            </button>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

export default function AdminToursPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [tours, setTours] = useState(null);
  const [runs, setRuns] = useState([]);
  const [sites, setSites] = useState([]);
  const [tab, setTab] = useState('runs');
  const [builder, setBuilder] = useState(false);

  const load = async () => {
    try {
      const [t, r, s] = await Promise.all([
        api.get('/admin/tours'),
        api.get('/admin/tour-runs'),
        api.get('/admin/sites'),
      ]);
      setTours(t.tours);
      setRuns(r.runs);
      setSites(s.sites);
    } catch (err) {
      toast.error(err.message);
      setTours([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (!tours) return <LoadingPage label="Loading tours" />;

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Operations</div>
          <h1>Tours</h1>
          <p className="lead">Proof of service: which checkpoints were walked, and when.</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setBuilder(true)} disabled={!sites.length}>
            <Icon name="plus" size={16} /> Build tour
          </button>
        )}
      </div>

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'runs', label: `Completed walks (${runs.length})` },
          { value: 'templates', label: `Tour templates (${tours.length})` },
        ]}
      />

      {tab === 'runs' ? (
        <div className="card">
          {runs.length === 0 ? (
            <Empty icon="route" title="No tours walked yet" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Tour</th>
                    <th>Officer</th>
                    <th>Site</th>
                    <th>Started</th>
                    <th>Checkpoints</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="strong small">{r.tour_name}</td>
                      <td className="small">{r.officer}</td>
                      <td className="small muted">{r.site_name}</td>
                      <td className="nowrap small">
                        {fmtDateTime(r.started_at)}
                        <div className="tiny muted">{fmtRelative(r.started_at)}</div>
                      </td>
                      <td className="small">
                        {r.done}/{r.total}
                        {r.skipped > 0 && <Chip kind="warn">{r.skipped} skipped</Chip>}
                      </td>
                      <td>
                        <StatusChip value={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          {tours.length === 0 ? (
            <Empty icon="route" title="No tours configured">Build one so officers have a route to walk.</Empty>
          ) : (
            <div className="list">
              {tours.map((t) => (
                <div key={t.id} className="list-item" style={{ cursor: 'default' }}>
                  <div className="lead-icon">
                    <Icon name="route" size={18} />
                  </div>
                  <div className="grow">
                    <div className="strong small">{t.name}</div>
                    <div className="tiny muted">
                      {t.site_name}
                      {t.description ? ` - ${t.description}` : ''}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Chip kind="navy">{t.checkpoint_count} checkpoints</Chip>
                    {t.expected_minutes && <Chip>~{t.expected_minutes} min</Chip>}
                    {!t.active && <Chip kind="warn">Inactive</Chip>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {builder && <TourBuilder sites={sites} onClose={() => setBuilder(false)} onSaved={() => { setBuilder(false); load(); }} />}
    </div>
  );
}
