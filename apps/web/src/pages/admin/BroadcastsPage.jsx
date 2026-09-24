import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Field, Progress, useToast,
} from '../../components/ui.jsx';
import { BROADCAST_PRIORITY, ROLES, ROLE_LABEL } from '@shared/domain.js';

function ComposeDialog({ sites, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: '', body: '', priority: 'normal', requiresAck: false, audienceRole: '', audienceSiteId: '',
  });
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/broadcasts', {
        title: form.title.trim(),
        body: form.body.trim(),
        priority: form.priority,
        requiresAck: form.requiresAck,
        audienceRole: form.audienceRole || null,
        audienceSiteId: form.audienceSiteId ? Number(form.audienceSiteId) : null,
      });
      toast.success('Broadcast published.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New broadcast"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.title.trim().length < 3 || form.body.trim().length < 3}>
            Publish
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title" required>
          <input value={form.title} onChange={set('title')} placeholder="Hurricane season standby procedures" />
        </Field>
        <Field label="Message" required>
          <textarea value={form.body} onChange={set('body')} rows={6} />
        </Field>
        <div className="grid grid-2">
          <Field label="Priority">
            <select value={form.priority} onChange={set('priority')}>
              {BROADCAST_PRIORITY.map((p) => (
                <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
          </Field>
          <Field label="Send to">
            <select value={form.audienceRole} onChange={set('audienceRole')}>
              <option value="">Everyone</option>
              {Object.values(ROLES).map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}s only</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Limit to a site" hint="Optional. Officers working that site will see it.">
          <select value={form.audienceSiteId} onChange={set('audienceSiteId')}>
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.requiresAck} onChange={set('requiresAck')} />
          <span>
            Require acknowledgement
            <div className="tiny muted">Officers must confirm they have read it; you get a receipt list.</div>
          </span>
        </label>
      </div>
    </Modal>
  );
}

function ReceiptsDialog({ broadcast, onClose }) {
  const [receipts, setReceipts] = useState(null);

  useEffect(() => {
    api.get(`/broadcasts/${broadcast.id}/receipts`).then((r) => setReceipts(r.receipts)).catch(() => setReceipts([]));
  }, [broadcast.id]);

  if (!receipts) return <Modal title="Loading" onClose={onClose}><LoadingPage /></Modal>;

  const read = receipts.filter((r) => r.read_at).length;
  const acked = receipts.filter((r) => r.acknowledged_at).length;

  return (
    <Modal title={`Receipts: ${broadcast.title}`} onClose={onClose} wide>
      <div className="stack">
        <div className="grid grid-2">
          <div className="stat">
            <div className="label">Read</div>
            <div className="value">{read}/{receipts.length}</div>
            <div className="foot"><Progress label="Officers who have read it" value={read} max={receipts.length} ok={read === receipts.length} /></div>
          </div>
          {Boolean(broadcast.requires_ack) && (
            <div className="stat">
              <div className="label">Acknowledged</div>
              <div className="value">{acked}/{receipts.length}</div>
              <div className="foot"><Progress label="Officers who have acknowledged it" value={acked} max={receipts.length} ok={acked === receipts.length} /></div>
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Officer</th>
                <th>Read</th>
                {Boolean(broadcast.requires_ack) && <th>Acknowledged</th>}
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.employee_code}</td>
                  <td className="small">{r.name}</td>
                  <td className="small">
                    {r.read_at ? fmtDateTime(r.read_at) : <Chip kind="warn">Not yet</Chip>}
                  </td>
                  {Boolean(broadcast.requires_ack) && (
                    <td className="small">
                      {r.acknowledged_at ? <Chip kind="ok">{fmtDateTime(r.acknowledged_at)}</Chip> : <Chip kind="danger">Pending</Chip>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export default function BroadcastsPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [sites, setSites] = useState([]);
  const [compose, setCompose] = useState(false);
  const [receipts, setReceipts] = useState(null);

  const load = async () => {
    try {
      const [b, s] = await Promise.all([api.get('/broadcasts'), api.get('/admin/sites')]);
      setItems(b.broadcasts);
      setSites(s.sites);
    } catch (err) {
      toast.error(err.message);
      setItems([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const remove = async (b) => {
    try {
      await api.del(`/broadcasts/${b.id}`);
      toast.success('Broadcast removed.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!items) return <LoadingPage label="Loading broadcasts" />;

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Communication</div>
          <h1>Broadcasts</h1>
          <p className="lead">Company-wide notices, with read and acknowledgement receipts.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCompose(true)}>
          <Icon name="plus" size={16} /> New broadcast
        </button>
      </div>

      <div className="card">
        {items.length === 0 ? (
          <Empty icon="megaphone" title="Nothing published" />
        ) : (
          <div className="list">
            {items.map((b) => (
              <div key={b.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <div
                  className="lead-icon"
                  style={
                    b.priority === 'urgent'
                      ? { background: 'var(--danger-bg)', color: 'var(--danger)' }
                      : b.priority === 'important'
                        ? { background: 'var(--warn-bg)', color: 'var(--warn)' }
                        : undefined
                  }
                >
                  <Icon name="megaphone" size={18} />
                </div>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 7 }}>
                    <span className="strong small">{b.title}</span>
                    <StatusChip value={b.priority} />
                    {Boolean(b.requires_ack) && <Chip kind="brand">Ack required</Chip>}
                    {b.audience_role && <Chip kind="navy">{ROLE_LABEL[b.audience_role]}s</Chip>}
                  </div>
                  <div className="tiny muted" style={{ marginTop: 3 }}>{b.body}</div>
                  <div className="tiny muted" style={{ marginTop: 3 }}>
                    {b.author} &middot; {fmtRelative(b.published_at)}
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => setReceipts(b)}>
                    <Icon name="eye" size={14} /> Receipts
                  </button>
                  {isAdmin && (
                    <button
                      className="btn btn-sm btn-ghost"
                      aria-label={`Delete broadcast: ${b.title}`}
                      onClick={() => remove(b)}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {compose && <ComposeDialog sites={sites} onClose={() => setCompose(false)} onSaved={() => { setCompose(false); load(); }} />}
      {receipts && <ReceiptsDialog broadcast={receipts} onClose={() => setReceipts(null)} />}
    </div>
  );
}
