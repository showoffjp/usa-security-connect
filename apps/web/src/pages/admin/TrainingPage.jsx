import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime, toDateInput } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, Modal, Field, Progress, useToast,
} from '../../components/ui.jsx';
import { ROLES, ROLE_LABEL } from '@shared/domain.js';

function TrainingDialog({ onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: '', description: '', videoUrl: '', minutes: 7, required: true, dueAt: '', audienceRole: '',
  });
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/training', {
        title: form.title.trim(),
        description: form.description || undefined,
        videoUrl: form.videoUrl || undefined,
        durationSeconds: Math.round(Number(form.minutes) * 60),
        required: form.required,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
        audienceRole: form.audienceRole || null,
      });
      toast.success('Training published.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add training"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.title.trim().length < 3}>Publish</button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title" required>
          <input value={form.title} onChange={set('title')} placeholder="Post Orders: Lobby Access Control" />
        </Field>
        <Field label="Description">
          <textarea value={form.description} onChange={set('description')} rows={3} />
        </Field>
        <Field label="Video URL" hint="Where the file is hosted. Leave blank for a placeholder.">
          <input value={form.videoUrl} onChange={set('videoUrl')} placeholder="https://..." />
        </Field>
        <div className="grid grid-3">
          <Field label="Length (minutes)">
            <input type="number" min="1" step="0.5" value={form.minutes} onChange={set('minutes')} />
          </Field>
          <Field label="Due date">
            <input type="date" value={form.dueAt} onChange={set('dueAt')} min={toDateInput(new Date())} />
          </Field>
          <Field label="Audience">
            <select value={form.audienceRole} onChange={set('audienceRole')}>
              <option value="">Everyone</option>
              {Object.values(ROLES).map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}s</option>
              ))}
            </select>
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.required} onChange={set('required')} />
          <span>
            Required
            <div className="tiny muted">Must be watched in full; the server verifies this, not just the player.</div>
          </span>
        </label>
      </div>
    </Modal>
  );
}

function CompletionDialog({ training, onClose }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.get(`/training/${training.id}/completion`).then((r) => setRows(r.completion)).catch(() => setRows([]));
  }, [training.id]);

  if (!rows) return <Modal title="Loading" onClose={onClose}><LoadingPage /></Modal>;
  const done = rows.filter((r) => r.completed_at).length;

  return (
    <Modal title={`Completion: ${training.title}`} onClose={onClose} wide>
      <div className="stack">
        <div className="stat">
          <div className="label">Completed</div>
          <div className="value">{done}/{rows.length}</div>
          <div className="foot"><Progress label="Officers who have completed it" value={done} max={rows.length} ok={done === rows.length} /></div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Officer</th>
                <th>Progress</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.employee_code}</td>
                  <td className="small">{r.name}</td>
                  <td style={{ minWidth: 120 }}>
                    <Progress
                      label="Progress through this training"
                      value={Math.min(training.duration_seconds, r.seconds_watched || 0)}
                      max={training.duration_seconds || 1}
                      ok={Boolean(r.completed_at)}
                    />
                  </td>
                  <td className="small">
                    {r.completed_at ? <Chip kind="ok">{fmtDate(r.completed_at)}</Chip> : <Chip kind="warn">Outstanding</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminTrainingPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [dialog, setDialog] = useState(false);
  const [completion, setCompletion] = useState(null);

  const load = async () => {
    try {
      setItems((await api.get('/training')).trainings);
    } catch (err) {
      toast.error(err.message);
      setItems([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (!items) return <LoadingPage label="Loading training" />;

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Communication</div>
          <h1>Training</h1>
          <p className="lead">Assign videos and track who has actually watched them.</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setDialog(true)}>
            <Icon name="plus" size={16} /> Add training
          </button>
        )}
      </div>

      <div className="card">
        {items.length === 0 ? (
          <Empty icon="book" title="No training published" />
        ) : (
          <div className="list">
            {items.map((t) => (
              <div key={t.id} className="list-item" style={{ cursor: 'default' }}>
                <div className="lead-icon">
                  <Icon name="play" size={18} />
                </div>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 7 }}>
                    <span className="strong small">{t.title}</span>
                    {Boolean(t.required) && <Chip kind="brand">Required</Chip>}
                    {t.audience_role && <Chip kind="navy">{ROLE_LABEL[t.audience_role]}s</Chip>}
                  </div>
                  <div className="tiny muted">{t.description}</div>
                  <div className="tiny muted">
                    {Math.round(t.duration_seconds / 60)} min
                    {t.due_at ? ` - due ${fmtDate(t.due_at)}` : ''}
                  </div>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => setCompletion(t)}>
                  <Icon name="eye" size={14} /> Completion
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {dialog && <TrainingDialog onClose={() => setDialog(false)} onSaved={() => { setDialog(false); load(); }} />}
      {completion && <CompletionDialog training={completion} onClose={() => setCompletion(null)} />}
    </div>
  );
}
