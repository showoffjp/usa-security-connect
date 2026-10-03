import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';
import { Chip, Empty, Field, Modal, useToast } from '../../components/ui.jsx';
import { COMMENDATION_CATEGORIES, COMMENDATION_LABEL } from '@shared/domain.js';

function CommendDialog({ userId, name, onClose, onDone }) {
  const toast = useToast();
  const [category, setCategory] = useState('professionalism');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.post('/commendations', { userId, category, message: message.trim() });
      toast.success(`${name.split(' ')[0]} will see it on their home screen.`);
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Commend ${name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || message.trim().length < 10}>
            {busy ? 'Sending...' : 'Commend'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="For" required error={errors.category}>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {COMMENDATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {COMMENDATION_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What they did" required error={errors.message} hint="The officer reads this word for word.">
          <textarea rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** An officer's commendations on their record, and one to add. */
export default function CommendationsCard({ userId, name, isAdmin, isSelf }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [commending, setCommending] = useState(false);
  const load = useCallback(async () => {
    try {
      setList((await api.get(`/commendations?userId=${userId}`)).commendations);
    } catch (err) {
      toast.error(err.message);
    }
  }, [userId, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const remove = async (c) => {
    if (!window.confirm(`Remove this commendation from ${c.from}? ${name.split(' ')[0]} will no longer see it.`)) return;
    try {
      await api.del(`/commendations/${c.id}`);
      toast.success('Removed.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!list) return null;
  return (
    <div className="card" id="commendations">
      <div className="card-head wrap">
        <h3>Commendations</h3>
        <span className="small muted">
          {list.length} · {list.filter((c) => c.source === 'client').length} from clients
        </span>
        {!isSelf && (
          <button className="btn btn-ghost btn-sm" onClick={() => setCommending(true)}>
            Commend
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <Empty icon="check" title="None yet">
          Thanks from clients and supervisors appear here.
        </Empty>
      ) : (
        <div className="card-body stack">
          {list.slice(0, 8).map((c) => (
            <div key={c.id} className="commendation">
              <div className="row wrap" style={{ gap: 6 }}>
                <Chip kind="ok">{c.category_label}</Chip>
                <Chip kind={c.source === 'client' ? 'info' : 'navy'}>{c.source === 'client' ? 'Client' : 'Staff'}</Chip>
                <span className="tiny muted">
                  {c.from}
                  {c.site_name ? ` · ${c.site_name}` : ''} · {fmtDate(c.created_at)}
                  {c.seen ? '' : ' · not read yet'}
                </span>
                {isAdmin && (
                  <button className="link-btn tiny" onClick={() => remove(c)} aria-label={`Remove the commendation from ${c.from}`}>
                    Remove
                  </button>
                )}
              </div>
              <p className="small" style={{ margin: '6px 0 0' }}>{c.message}</p>
            </div>
          ))}
        </div>
      )}
      {commending && (
        <CommendDialog
          userId={userId}
          name={name}
          onClose={() => setCommending(false)}
          onDone={() => {
            setCommending(false);
            load();
          }}
        />
      )}
    </div>
  );
}
