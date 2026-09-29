import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtTime } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, useToast } from '../../components/ui.jsx';

export const ACTIVITY_LABEL = {
  patrol: 'Patrol', observation: 'Observation', access: 'Access', alarm: 'Alarm', safety: 'Safety',
  customer_service: 'Customer service', other: 'Other',
};
export const ISSUE_LABEL = {
  lighting: 'Lighting', door_lock: 'Door or lock', leak: 'Leak', damage: 'Damage', hazard: 'Hazard',
  cleanliness: 'Cleanliness', equipment: 'Equipment', other: 'Other',
};
export const ISSUE_STATUS = { open: ['warn', 'Open'], acknowledged: ['info', 'Client has seen it'], fixed: ['ok', 'Fixed'] };
export const PRIORITY_KIND = { urgent: 'danger', normal: '', low: '' };
export const FOUND_LABEL = {
  phone: 'Phone', wallet: 'Wallet or purse', keys: 'Keys', bag: 'Bag', id: 'ID or badge', clothing: 'Clothing',
  jewelry: 'Jewellery', other: 'Other',
};

/** Everything these tabs show, loaded once for the site the officer is on. */
export function useSiteLog() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api.get('/post-log/site'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, load };
}

function Wrap({ site, children }) {
  if (site.error) return <Banner kind="danger" title="This did not load">{site.error}</Banner>;
  if (!site.data) return <LoadingPage label="Loading" />;
  return children;
}

/* --------------------------------------------------------------- activity -- */

export function ActivityTab({ site, onDuty }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('patrol');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/post-log/activity', { body, category, clientVisible: !internal });
      setBody('');
      setInternal(false);
      toast.success('Logged.');
      site.load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (a) => {
    try {
      await api.del(`/post-log/activity/${a.id}`);
      site.load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <Wrap site={site}>
      {onDuty && (
        <form className="card card-pad stack-sm" onSubmit={add}>
          <label className="strong small" htmlFor="activity-body">
            Log what happened
          </label>
          <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Kind of entry">
            {site.data?.categories.activity.map((c) => (
              <button
                key={c}
                type="button"
                className={`btn btn-sm ${category === c ? 'btn-navy' : 'btn-ghost'}`}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {ACTIVITY_LABEL[c] || c}
              </button>
            ))}
          </div>
          <textarea
            id="activity-body"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            placeholder="Exterior patrol complete, all doors secure."
          />
          <div className="row-between wrap">
            <label className="row small">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} style={{ width: 'auto' }} />
              Internal only - not in the client's report
            </label>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || body.trim().length < 3}>
              <Icon name="check" size={15} /> {busy ? 'Saving...' : 'Log it'}
            </button>
          </div>
        </form>
      )}
      <div className="card">
        <div className="card-head">
          <h2 className="h3">Activity on this site</h2>
          <span className="small muted">Last 24 hours</span>
        </div>
        {!site.data?.activity.length ? (
          <Empty icon="clipboard" title="Nothing logged yet">
            Rounds, doors, alarms, anything the client should know you handled.
          </Empty>
        ) : (
          <ul className="list">
            {site.data.activity.map((a) => (
              <li key={a.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                <div className="nowrap small strong" style={{ width: 62 }}>{fmtTime(a.occurred_at)}</div>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Chip>{ACTIVITY_LABEL[a.category] || a.category}</Chip>
                    {!a.client_visible && <Chip kind="navy">Internal</Chip>}
                    <span className="tiny muted">{a.officer_name}</span>
                  </div>
                  <div className="small" style={{ marginTop: 4 }}>{a.body}</div>
                </div>
                {a.removable && (
                  <button className="btn btn-sm btn-ghost" onClick={() => remove(a)} aria-label={`Remove entry from ${fmtTime(a.occurred_at)}`}>
                    <Icon name="x" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Wrap>
  );
}

/* ----------------------------------------------------------------- issues -- */

function IssueDialog({ categories, priorities, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ category: 'lighting', priority: 'normal', locationText: '', description: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/post-log/issues', form);
      toast.success('Reported. The client sees it in their portal.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Report a building issue"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.description.trim().length < 5}>
            {busy ? 'Saving...' : 'Report it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="What kind" required>
            <select value={form.category} onChange={set('category')}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {ISSUE_LABEL[c] || c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How urgent">
            <select value={form.priority} onChange={set('priority')}>
              {priorities.map((p) => (
                <option key={p} value={p}>
                  {p === 'urgent' ? 'Urgent - security or safety' : p === 'normal' ? 'Normal' : 'Low'}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Where">
          <input value={form.locationText} onChange={set('locationText')} maxLength={160} placeholder="Garage level 2, northeast corner" />
        </Field>
        <Field label="What is wrong" required>
          <textarea rows={3} value={form.description} onChange={set('description')} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

export function IssuesTab({ site, onDuty }) {
  const [reporting, setReporting] = useState(false);
  return (
    <Wrap site={site}>
      <div className="card">
        <div className="card-head">
          <h2 className="h3">Building issues</h2>
          {onDuty && (
            <button className="btn btn-primary btn-sm" onClick={() => setReporting(true)}>
              <Icon name="plus" size={15} /> Report issue
            </button>
          )}
        </div>
        {!site.data?.issues.length ? (
          <Empty icon="building" title="No open issues">
            Lights out, doors that will not lock, leaks and hazards go here for the client to fix.
          </Empty>
        ) : (
          <ul className="list">
            {site.data.issues.map((i) => {
              const [kind, label] = ISSUE_STATUS[i.status] || ['', i.status];
              return (
                <li key={i.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className="strong small">{ISSUE_LABEL[i.category] || i.category}</span>
                      {i.priority === 'urgent' && <Chip kind="danger">Urgent</Chip>}
                      <Chip kind={kind}>{label}</Chip>
                    </div>
                    {i.location_text && <div className="tiny muted">{i.location_text}</div>}
                    <div className="small" style={{ marginTop: 3 }}>{i.description}</div>
                    {i.client_note && (
                      <div className="small" style={{ marginTop: 4 }}>
                        <strong>Client:</strong> {i.client_note}
                      </div>
                    )}
                    <div className="tiny muted" style={{ marginTop: 3 }}>
                      {i.reported_by_name} · {fmtDateTime(i.created_at)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {reporting && site.data && (
        <IssueDialog
          categories={site.data.categories.issues}
          priorities={site.data.categories.priorities}
          onClose={() => setReporting(false)}
          onDone={() => {
            setReporting(false);
            site.load();
          }}
        />
      )}
    </Wrap>
  );
}

/* ---------------------------------------------------------- lost & found -- */

function FoundDialog({ categories, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ description: '', category: 'phone', foundLocation: '', storedLocation: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/post-log/found', form);
      toast.success('Logged in lost and found.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Log a found item"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.description.trim().length < 3 || form.storedLocation.trim().length < 2}
          >
            {busy ? 'Saving...' : 'Log item'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Item" required hint="Enough to recognise it: colour, make, anything written on it.">
          <input value={form.description} onChange={set('description')} maxLength={300} />
        </Field>
        <Field label="Kind">
          <select value={form.category} onChange={set('category')}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {FOUND_LABEL[c] || c}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-2">
          <Field label="Found where">
            <input value={form.foundLocation} onChange={set('foundLocation')} maxLength={160} />
          </Field>
          <Field label="Kept where" required>
            <input value={form.storedLocation} onChange={set('storedLocation')} maxLength={160} placeholder="Security desk drawer" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ReturnDialog({ item, onClose, onDone }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/post-log/found/${item.id}/close`, { status: 'returned', returnedTo: to, returnedContact: contact });
      toast.success('Handed back.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Hand it back"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || to.trim().length < 2 || contact.trim().length < 5}>
            {busy ? 'Saving...' : 'Returned'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">{item.description}</div>
        <Field label="Collected by" required>
          <input value={to} onChange={(e) => setTo(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Phone or ID checked" required hint="Kept in case someone else later says it was theirs.">
          <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} />
        </Field>
      </div>
    </Modal>
  );
}

export function FoundTab({ site, onDuty }) {
  const [logging, setLogging] = useState(false);
  const [returning, setReturning] = useState(null);
  return (
    <Wrap site={site}>
      <div className="card">
        <div className="card-head">
          <h2 className="h3">Lost and found</h2>
          {onDuty && (
            <button className="btn btn-primary btn-sm" onClick={() => setLogging(true)}>
              <Icon name="plus" size={15} /> Log item
            </button>
          )}
        </div>
        {!site.data?.found.length ? (
          <Empty icon="clipboard" title="Nothing held here" />
        ) : (
          <ul className="list">
            {site.data.found.map((f) => (
              <li key={f.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="strong small">{f.description}</span>
                    {f.status === 'held' ? <Chip kind="warn">Held</Chip> : <Chip kind="ok">{f.status === 'returned' ? 'Returned' : 'Disposed'}</Chip>}
                  </div>
                  <div className="tiny muted" style={{ marginTop: 3 }}>
                    {FOUND_LABEL[f.category] || f.category}
                    {f.found_location ? ` · found in ${f.found_location}` : ''} · {fmtDateTime(f.found_at)}
                  </div>
                  <div className="small" style={{ marginTop: 2 }}>
                    {f.status === 'held' ? `Kept in: ${f.stored_location}` : f.returned_to ? `To ${f.returned_to} (${f.returned_contact})` : ''}
                  </div>
                </div>
                {onDuty && f.status === 'held' && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setReturning(f)}>
                    Hand back
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {logging && site.data && (
        <FoundDialog
          categories={site.data.categories.found}
          onClose={() => setLogging(false)}
          onDone={() => {
            setLogging(false);
            site.load();
          }}
        />
      )}
      {returning && (
        <ReturnDialog
          item={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            site.load();
          }}
        />
      )}
    </Wrap>
  );
}
