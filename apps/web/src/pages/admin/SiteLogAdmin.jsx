import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile } from '../../lib/api.js';
import { fmtDateTime, fmtTime, toDateInput } from '../../lib/format.js';
import { Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, useToast } from '../../components/ui.jsx';
import { ACTIVITY_LABEL, ISSUE_LABEL, ISSUE_STATUS, FOUND_LABEL } from '../officer/SiteLogTabs.jsx';

/** Download what the tab is showing, as a spreadsheet. */
export function CsvButton({ path, filename }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadFile(`${path}${path.includes('?') ? '&' : '?'}format=csv`, `${filename}.csv`);
        } catch (err) {
          toast.error(err.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="download" size={15} /> {busy ? 'Preparing...' : 'CSV'}
    </button>
  );
}

function SiteSelect({ sites, value, onChange }) {
  return (
    <select aria-label="Site" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto', maxWidth: 260 }}>
      <option value="">All sites</option>
      {sites.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );
}

/* --------------------------------------------------------------- activity -- */

export function ActivityAdmin({ sites, siteId, setSiteId }) {
  const toast = useToast();
  const [day, setDay] = useState(toDateInput(new Date()));
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ date: day });
    if (siteId) q.set('siteId', siteId);
    api.get(`/post-log/admin/activity?${q}`).then(
      (d) => alive && setData(d),
      (err) => {
        toast.error(err.message);
        alive && setData({ entries: [] });
      }
    );
    return () => {
      alive = false;
    };
  }, [day, siteId, toast]);

  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <h2 className="h3">Activity log</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          <input type="date" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 'auto' }} />
          <SiteSelect sites={sites} value={siteId} onChange={setSiteId} />
          <CsvButton path={`/post-log/admin/activity?date=${day}${siteId ? `&siteId=${siteId}` : ''}`} filename={`activity-${day}`} />
        </div>
      </div>
      {!data ? (
        <LoadingPage label="Loading" />
      ) : data.entries.length === 0 ? (
        <Empty icon="clipboard" title="Nothing logged that day" />
      ) : (
        <ul className="list">
          {data.entries.map((a) => (
            <li key={a.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
              <div className="nowrap small strong" style={{ width: 62 }}>{fmtTime(a.occurred_at)}</div>
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  <Chip>{ACTIVITY_LABEL[a.category] || a.category}</Chip>
                  {!a.client_visible && <Chip kind="navy">Internal</Chip>}
                  <span className="tiny muted">
                    {a.officer_name} · {a.site_name}
                    {a.post_name ? `, ${a.post_name}` : ''}
                  </span>
                </div>
                <div className="small" style={{ marginTop: 4 }}>{a.body}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- issues -- */

export function IssuesAdmin({ sites, siteId, setSiteId }) {
  const toast = useToast();
  const [status, setStatus] = useState('unresolved');
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ status });
    if (siteId) q.set('siteId', siteId);
    try {
      setData(await api.get(`/post-log/admin/issues?${q}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { issues: [], counts: {} });
    }
  }, [status, siteId, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const setIssue = async (i, next) => {
    try {
      await api.post(`/post-log/issues/${i.id}/status`, { status: next });
      toast.success(next === 'fixed' ? 'Marked fixed.' : 'Reopened.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const c = data?.counts || {};
  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <Segmented
          label="Show"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'unresolved', label: `Unresolved (${(c.open || 0) + (c.acknowledged || 0)})` },
            { value: 'open', label: 'Not yet seen' },
            { value: 'fixed', label: 'Fixed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <div className="row wrap" style={{ gap: 8 }}>
          <SiteSelect sites={sites} value={siteId} onChange={setSiteId} />
          <CsvButton path={`/post-log/admin/issues?status=${status}${siteId ? `&siteId=${siteId}` : ''}`} filename={`building-issues-${status}`} />
        </div>
      </div>
      {!data ? (
        <LoadingPage label="Loading" />
      ) : data.issues.length === 0 ? (
        <Empty icon="building" title="No issues here" />
      ) : (
        <ul className="list">
          {data.issues.map((i) => {
            const [kind, label] = ISSUE_STATUS[i.status] || ['', i.status];
            return (
              <li key={i.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="strong small">
                      {ISSUE_LABEL[i.category] || i.category} · {i.site_name}
                    </span>
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
                    Reported by {i.reported_by_name} {fmtDateTime(i.created_at)}
                    {i.fixed_at ? ` · fixed ${fmtDateTime(i.fixed_at)} by ${i.closed_by_client_name || i.closed_by_staff_name || 'someone'}` : ''}
                  </div>
                </div>
                {i.status === 'fixed' ? (
                  <button className="btn btn-sm btn-ghost" onClick={() => setIssue(i, 'open')}>
                    Reopen
                  </button>
                ) : (
                  <button className="btn btn-sm btn-ghost" onClick={() => setIssue(i, 'fixed')}>
                    Mark fixed
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- lost & found -- */

export function FoundAdmin() {
  const toast = useToast();
  const [status, setStatus] = useState('held');
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/post-log/admin/found?status=${status}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { items: [], overdue: 0 });
    }
  }, [status, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const dispose = async (f) => {
    try {
      await api.post(`/post-log/found/${f.id}/close`, { status: 'disposed' });
      toast.success('Recorded as disposed of.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <Segmented
          label="Show"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'held', label: 'Held' },
            { value: 'returned', label: 'Returned' },
            { value: 'disposed', label: 'Disposed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <div className="row wrap" style={{ gap: 8 }}>
          {data?.overdue > 0 && <Chip kind="warn">{data.overdue} held over 30 days</Chip>}
          <CsvButton path={`/post-log/admin/found?status=${status}`} filename={`lost-and-found-${status}`} />
        </div>
      </div>
      {!data ? (
        <LoadingPage label="Loading" />
      ) : data.items.length === 0 ? (
        <Empty icon="clipboard" title="Nothing here" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Site</th>
                <th>Found</th>
                <th>Kept / left with</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((f) => (
                <tr key={f.id}>
                  <td>
                    <div className="strong small">{f.description}</div>
                    <div className="tiny muted">{FOUND_LABEL[f.category] || f.category}</div>
                  </td>
                  <td className="small">
                    {f.site_name}
                    {f.found_location && <div className="tiny muted">{f.found_location}</div>}
                  </td>
                  <td className="small">
                    {fmtDateTime(f.found_at)}
                    <div className="tiny muted">{f.found_by_name}</div>
                  </td>
                  <td className="small">
                    {f.status === 'held' ? (
                      f.stored_location
                    ) : f.status === 'returned' ? (
                      <>
                        {f.returned_to}
                        <div className="tiny muted">
                          {f.returned_contact} · {f.closed_by_name}, {fmtDateTime(f.closed_at)}
                        </div>
                      </>
                    ) : (
                      <span className="muted">Disposed of {fmtDateTime(f.closed_at)}</span>
                    )}
                  </td>
                  <td>
                    {f.status === 'held' && (
                      <button className="btn btn-sm btn-ghost" onClick={() => dispose(f)}>
                        Dispose
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


/* --------------------------------------------------------- site contacts -- */

const BLANK_CONTACT = { name: '', role: '', phone: '', email: '', notes: '', afterHours: false, sort: 0 };

export function ContactDialog({ contact, onSave, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState(
    contact
      ? { name: contact.name, role: contact.role, phone: contact.phone || '', email: contact.email || '', notes: contact.notes || '', afterHours: contact.after_hours, sort: contact.sort || 0 }
      : BLANK_CONTACT
  );
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await onSave({ ...form, sort: Number(form.sort) || 0, email: form.email || null, phone: form.phone || null });
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={contact ? 'Edit contact' : 'Add a contact'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.trim().length < 2 || form.role.trim().length < 2}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Name" required error={errors.name}>
            <input value={form.name} onChange={set('name')} maxLength={120} />
          </Field>
          <Field label="Who they are" required error={errors.role} hint="Property manager, maintenance, alarm company.">
            <input value={form.role} onChange={set('role')} maxLength={80} />
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label="Phone" error={errors.phone}>
            <input type="tel" value={form.phone} onChange={set('phone')} maxLength={40} />
          </Field>
          <Field label="Email" error={errors.email}>
            <input type="email" value={form.email} onChange={set('email')} maxLength={160} />
          </Field>
        </div>
        <Field label="Notes for officers">
          <input value={form.notes} onChange={set('notes')} maxLength={300} placeholder="Call first for anything leaking." />
        </Field>
        <label className="row small">
          <input type="checkbox" checked={form.afterHours} onChange={set('afterHours')} style={{ width: 'auto' }} />
          Reachable after hours
        </label>
      </div>
    </Modal>
  );
}

export function ContactList({ contacts, onEdit, onRemove, who }) {
  if (!contacts.length) return <Empty icon="phone" title="No contacts yet">Officers on post see these, with a button to call.</Empty>;
  return (
    <ul className="list">
      {contacts.map((c) => (
        <li key={c.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
          <div className="grow">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="strong small">{c.role}</span>
              {c.after_hours && <Chip kind="navy">After hours</Chip>}
              {who && <span className="tiny muted">{who(c)}</span>}
            </div>
            <div className="small">
              {c.name}
              {c.phone ? ` · ${c.phone}` : ''}
              {c.email ? ` · ${c.email}` : ''}
            </div>
            {c.notes && <div className="tiny muted">{c.notes}</div>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm btn-ghost" onClick={() => onEdit(c)}>
              Edit
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => onRemove(c)} aria-label={`Remove ${c.name}`}>
              Remove
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ContactsAdmin({ sites, siteId, setSiteId }) {
  const toast = useToast();
  const chosen = siteId || sites[0]?.id || '';
  const [contacts, setContacts] = useState(null);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    if (!chosen) return undefined;
    let alive = true;
    setContacts(null);
    api.get(`/post-log/admin/contacts?siteId=${chosen}`).then(
      (d) => alive && setContacts(d.contacts),
      (err) => {
        toast.error(err.message);
        alive && setContacts([]);
      }
    );
    return () => {
      alive = false;
    };
  }, [chosen, toast]);

  const save = async (body) => {
    const d = editing === 'new'
      ? await api.post('/post-log/admin/contacts', { ...body, siteId: Number(chosen) })
      : await api.patch(`/post-log/admin/contacts/${editing.id}`, body);
    setContacts(d.contacts);
    setEditing(null);
    toast.success('Saved. Officers on post see it now.');
  };
  const remove = async (c) => {
    try {
      setContacts((await api.del(`/post-log/admin/contacts/${c.id}`)).contacts);
      toast.success(`${c.name} removed.`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <select aria-label="Site" value={chosen} onChange={(e) => setSiteId(e.target.value)} style={{ width: 'auto', maxWidth: 300 }}>
          {sites.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')} disabled={!chosen}>
          <Icon name="plus" size={15} /> Add contact
        </button>
      </div>
      {!contacts ? (
        <LoadingPage label="Loading" />
      ) : (
        <ContactList
          contacts={contacts}
          onEdit={setEditing}
          onRemove={remove}
          who={(c) => (c.added_by_client_name ? `added by ${c.added_by_client_name} (client)` : c.added_by_user_name ? `added by ${c.added_by_user_name}` : '')}
        />
      )}
      {editing && <ContactDialog contact={editing === 'new' ? null : editing} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}
