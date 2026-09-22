import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';
import {
  Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, StatusChip, useToast,
} from '../../components/ui.jsx';

/**
 * A generated password is shown once and never again, so it gets its own
 * dialog rather than a toast that scrolls away while the admin finds the phone.
 */
function CredentialDialog({ credential, onClose }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${credential.email}\n${credential.password}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal
      title="Portal password"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={copy}>
            <Icon name="clipboard" size={16} /> {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            I have sent it
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner kind="warn" title="Shown once">
          {credential.note}
        </Banner>
        <dl className="kv">
          <dt>Sign in at</dt>
          <dd className="mono">{window.location.origin}/portal</dd>
          <dt>Email</dt>
          <dd className="mono">{credential.email}</dd>
          <dt>Password</dt>
          <dd className="mono strong" style={{ fontSize: '1.1rem', letterSpacing: '0.02em' }}>
            {credential.password}
          </dd>
        </dl>
      </div>
    </Modal>
  );
}

function ContactDialog({ contact, sites, onClose, onSaved, onCredential }) {
  const toast = useToast();
  const editing = Boolean(contact);
  const [name, setName] = useState(contact?.name ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [company, setCompany] = useState(contact?.company ?? '');
  const [siteIds, setSiteIds] = useState((contact?.sites ?? []).map((s) => s.id));
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const toggle = (id) =>
    setSiteIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));

  const save = async () => {
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      if (editing) {
        await api.patch(`/admin/clients/${contact.id}`, {
          name: name.trim(),
          company: company.trim() || null,
          siteIds,
        });
        toast.success('Contact updated.');
      } else {
        const res = await api.post('/admin/clients', {
          email: email.trim(),
          name: name.trim(),
          company: company.trim() || null,
          siteIds,
        });
        onCredential({ email: res.client.email, password: res.password, note: res.note });
      }
      onSaved();
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${contact.name}` : 'New portal login'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim() || (!editing && !email.trim())}>
            {editing ? 'Save' : 'Create login'}
          </button>
        </>
      }
    >
      <div className="stack">
        {error && <Banner kind="danger">{error}</Banner>}

        <Field label="Contact name" required error={fieldErrors.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana Whitfield" />
        </Field>

        <Field
          label="Email address"
          required
          error={fieldErrors.email}
          hint={editing ? 'The email address cannot be changed. Delete and recreate if it is wrong.' : 'This is their username.'}
        >
          <input
            type="email"
            value={email}
            disabled={editing}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="dana@example.com"
          />
        </Field>

        <Field label="Company" hint="Shown in the portal header.">
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Riverfront Holdings LLC" />
        </Field>

        <Field
          label="Properties they can see"
          hint="They see coverage, patrols and incidents for these sites only - never pay, margin or another client."
        >
          <div className="stack-sm" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {sites.map((s) => (
              <label key={s.id} className="check">
                <input type="checkbox" checked={siteIds.includes(s.id)} onChange={() => toggle(s.id)} />
                <span>
                  <span className="strong">{s.name}</span>
                  {s.client_name && <span className="muted small"> &middot; {s.client_name}</span>}
                </span>
              </label>
            ))}
          </div>
        </Field>

        {siteIds.length === 0 && (
          <Banner kind="info">
            With no property selected they can sign in but will be told to contact their account manager.
          </Banner>
        )}
      </div>
    </Modal>
  );
}

export default function ClientsPage() {
  const toast = useToast();
  const [clients, setClients] = useState(null);
  const [sites, setSites] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // contact object, or 'new'
  const [credential, setCredential] = useState(null);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.get('/admin/clients'), api.get('/admin/sites')]);
      setClients(c.clients);
      setSites(s.sites);
      setError('');
    } catch (err) {
      setError(err.message);
      setClients([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn, message) => {
    try {
      await fn();
      toast.success(message);
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const resetPassword = (c) =>
    act(async () => {
      const res = await api.post(`/admin/clients/${c.id}/reset-password`);
      setCredential({ email: res.email, password: res.password, note: res.note });
    }, 'Password reset.');

  const remove = (c) => {
    if (!window.confirm(`Delete the portal login for ${c.name}? They will lose access immediately.`)) return;
    act(() => api.del(`/admin/clients/${c.id}`), 'Login deleted.');
  };

  const toggleStatus = (c) =>
    act(
      () => api.patch(`/admin/clients/${c.id}`, { status: c.status === 'active' ? 'suspended' : 'active' }),
      c.status === 'active' ? 'Login suspended.' : 'Login reactivated.'
    );

  if (!clients) return <LoadingPage label="Loading client logins" />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Client portal</h1>
          <p className="muted">
            Read-only logins for site contacts. They see coverage, patrol proof and incidents for their own
            properties only.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} /> New login
        </button>
      </div>

      {error && <Banner kind="danger">{error}</Banner>}

      {clients.length === 0 ? (
        <div className="card card-pad">
          <Empty
            icon="building"
            title="No client logins yet"
            action={
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                Create the first one
              </button>
            }
          >
            Give a site contact their own read-only view of the service you provide.
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Contact</th>
                <th scope="col">Company</th>
                <th scope="col">Properties</th>
                <th scope="col">Status</th>
                <th scope="col">Last signed in</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="strong">{c.name}</div>
                    <div className="tiny muted mono">{c.email}</div>
                  </td>
                  <td>{c.company || <span className="muted">--</span>}</td>
                  <td>
                    {c.sites.length === 0 ? (
                      <Chip kind="warn">None linked</Chip>
                    ) : (
                      <div className="row wrap" style={{ gap: 4 }}>
                        {c.sites.map((s) => (
                          <Chip key={s.id}>{s.name}</Chip>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusChip value={c.status} />
                    {c.locked && (
                      <div style={{ marginTop: 4 }}>
                        <Chip kind="danger">Locked out</Chip>
                      </div>
                    )}
                  </td>
                  <td className="nowrap small muted">
                    {c.last_login_at ? fmtRelative(c.last_login_at) : 'Never'}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                      {c.locked && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => act(() => api.post(`/admin/clients/${c.id}/unlock`), 'Unlocked.')}
                        >
                          Unlock
                        </button>
                      )}
                      <button className="btn btn-sm btn-ghost" onClick={() => resetPassword(c)}>
                        Reset password
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => toggleStatus(c)}>
                        {c.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(c)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ContactDialog
          contact={editing === 'new' ? null : editing}
          sites={sites}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onCredential={setCredential}
        />
      )}

      {credential && <CredentialDialog credential={credential} onClose={() => setCredential(null)} />}
    </div>
  );
}
