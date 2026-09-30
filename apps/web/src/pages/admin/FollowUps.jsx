import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDateTime, toDateInput } from '../../lib/format.js';
import { Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, useToast } from '../../components/ui.jsx';

/** Supervisors and administrators, who can own a follow-up. */
export function useOwners() {
  const [owners, setOwners] = useState([]);
  useEffect(() => {
    api.get('/admin/employees').then(
      (d) => setOwners((d.employees || []).filter((e) => e.status === 'active' && ['supervisor', 'admin'].includes(e.role))),
      () => setOwners([])
    );
  }, []);
  return owners;
}

function DoneDialog({ action, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onDone((await api.patch(`/incidents/actions/${action.id}`, { status: 'done', note })).actions);
      toast.success('Follow-up done.');
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Mark done"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || note.trim().length < 3}>
            {busy ? 'Saving...' : 'Mark done'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small strong">{action.title}</div>
        <Field label="What was done" required hint="Kept on the incident for the record. The client sees only that it is done.">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

/** The follow-ups on one incident, or across all of them, with done and reopen. */
export function FollowUpList({ actions, onChange, showIncident = false, empty = 'No follow-ups yet' }) {
  const toast = useToast();
  const [closing, setClosing] = useState(null);
  const reopen = async (a) => {
    try {
      onChange((await api.patch(`/incidents/actions/${a.id}`, { status: 'open' })).actions, a);
    } catch (err) {
      toast.error(err.message);
    }
  };
  if (!actions.length) return <Empty icon="check" title={empty} />;
  return (
    <>
      <ul className="list follow-ups">
        {actions.map((a) => (
          <li key={a.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
            <span className={`lead-icon ${a.status === 'done' ? 'fu-done' : a.overdue ? 'fu-overdue' : ''}`} aria-hidden="true">
              <Icon name={a.status === 'done' ? 'check' : 'clock'} size={16} />
            </span>
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                <strong className="small" style={a.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>
                  {a.title}
                </strong>
                {a.overdue && <Chip kind="danger">Overdue</Chip>}
                {a.status === 'done' && <Chip kind="ok">Done</Chip>}
                {!a.client_visible && <Chip>Internal</Chip>}
              </div>
              <div className="tiny muted">
                {showIncident && `${a.ref_number}${a.site_name ? `, ${a.site_name}` : ''} · `}
                {a.owner_name || 'No owner'}
                {a.due_on ? ` · due ${fmtDate(a.due_on)}` : ''}
                {a.status === 'done' && a.done_at ? ` · done ${fmtDateTime(a.done_at)}${a.done_by_name ? ` by ${a.done_by_name}` : ''}` : ''}
              </div>
              {a.status === 'done' && a.done_note && <div className="small" style={{ marginTop: 3 }}>{a.done_note}</div>}
            </div>
            {a.status === 'open' ? (
              <button className="btn btn-sm" onClick={() => setClosing(a)}>
                Mark done
              </button>
            ) : (
              <button className="btn btn-sm btn-ghost" onClick={() => reopen(a)}>
                Reopen
              </button>
            )}
          </li>
        ))}
      </ul>
      {closing && (
        <DoneDialog
          action={closing}
          onClose={() => setClosing(null)}
          onDone={(list) => {
            const a = closing;
            setClosing(null);
            onChange(list, a);
          }}
        />
      )}
    </>
  );
}

/** Add a follow-up to an incident. */
export function AddFollowUp({ incidentId, owners, onAdded }) {
  const toast = useToast();
  const week = new Date(Date.now() + 7 * 86400000);
  const [form, setForm] = useState({ title: '', ownerId: '', dueOn: toDateInput(week), clientVisible: true });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await api.post(`/incidents/${incidentId}/actions`, {
        title: form.title,
        ownerId: form.ownerId ? Number(form.ownerId) : null,
        dueOn: form.dueOn || null,
        clientVisible: form.clientVisible,
      });
      setForm((f) => ({ ...f, title: '' }));
      onAdded(d.actions);
      toast.success('Follow-up added.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack-sm" onSubmit={add}>
      <Field label="What needs doing">
        <input value={form.title} onChange={set('title')} maxLength={300} placeholder="e.g. Get the fence panel repaired with the property manager" />
      </Field>
      <div className="grid grid-2">
        <Field label="Owner">
          <select value={form.ownerId} onChange={set('ownerId')}>
            <option value="">Nobody yet</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.first_name} {o.last_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due">
          <input type="date" value={form.dueOn} onChange={set('dueOn')} />
        </Field>
      </div>
      <div className="row-between wrap" style={{ gap: 8 }}>
        <label className="check">
          <input type="checkbox" checked={form.clientVisible} onChange={set('clientVisible')} />
          The client can see this
        </label>
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || form.title.trim().length < 5}>
          <Icon name="plus" size={15} /> Add follow-up
        </button>
      </div>
    </form>
  );
}

/** Every follow-up across incidents: open ones first, soonest due first. */
export function FollowUpsTab() {
  const toast = useToast();
  const [show, setShow] = useState('open');
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/incidents/follow-ups?show=${show}`));
    } catch (err) {
      toast.error(err.message);
      setData({ actions: [], counts: { open: 0, overdue: 0, mine: 0 } });
    }
  }, [show, toast]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="stack">
      <Segmented
        label="Follow-ups"
        value={show}
        onChange={setShow}
        options={[
          { value: 'open', label: `Open${data ? ` (${data.counts.open})` : ''}` },
          { value: 'overdue', label: `Overdue${data?.counts.overdue ? ` (${data.counts.overdue})` : ''}` },
          { value: 'mine', label: `Mine${data?.counts.mine ? ` (${data.counts.mine})` : ''}` },
          { value: 'all', label: 'All, with done' },
        ]}
      />
      <div className="card">
        {!data ? (
          <LoadingPage label="Loading follow-ups" />
        ) : (
          <FollowUpList
            actions={data.actions}
            showIncident
            onChange={() => load()}
            empty={show === 'overdue' ? 'Nothing overdue' : show === 'mine' ? 'Nothing assigned to you' : 'No follow-ups'}
          />
        )}
      </div>
    </div>
  );
}
