import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import {
  Banner, Chip, Empty, Icon, LoadingPage, Modal, Segmented, StatusChip, Stat, useToast,
} from '../../components/ui.jsx';

const KIND_LABEL = {
  invoice_issued: 'Invoice issued',
  portal_invited: 'Portal account created',
  portal_password_reset: 'Portal password reset',
};

const STATUS_TONE = { sent: 'ok', skipped: 'warn', failed: 'danger', queued: '' };

/** The whole message, for when somebody has to send it by hand. */
function MessageDialog({ id, onClose }) {
  const toast = useToast();
  const [email, setEmail] = useState(null);

  useEffect(() => {
    api
      .get(`/admin/emails/${id}`)
      .then((r) => setEmail(r.email))
      .catch((err) => {
        toast.error(err.message);
        onClose();
      });
  }, [id, onClose, toast]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${email.subject}\n\n${email.body}`);
      toast.success('Copied.');
    } catch {
      toast.error('Your browser would not let us copy that.');
    }
  };

  return (
    <Modal
      title={email ? email.subject : 'Message'}
      onClose={onClose}
      wide
      footer={
        email && (
          <>
            <button className="btn btn-ghost" onClick={copy}>
              <Icon name="clipboard" size={16} /> Copy
            </button>
            <a className="btn btn-primary" href={`mailto:${email.to_email}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`}>
              <Icon name="megaphone" size={16} /> Open in mail app
            </a>
          </>
        )
      }
    >
      {!email ? (
        <LoadingPage label="Loading the message" />
      ) : (
        <div className="stack">
          <dl className="kv">
            <dt>To</dt>
            <dd>
              {email.to_name ? `${email.to_name} <${email.to_email}>` : email.to_email}
            </dd>
            <dt>Type</dt>
            <dd>{KIND_LABEL[email.kind] || email.kind}</dd>
            <dt>Status</dt>
            <dd>
              <Chip kind={STATUS_TONE[email.status]}>{email.status}</Chip>
              {email.error && <div className="tiny muted">{email.error}</div>}
            </dd>
            <dt>Created</dt>
            <dd>{fmtDateTime(email.created_at)}</dd>
          </dl>

          <div>
            <h3 className="small strong">Message</h3>
            <pre
              style={{
                whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0,
                padding: 14, background: 'var(--surface-2, #f6f7f9)', borderRadius: 8,
                fontSize: '0.86rem', lineHeight: 1.6,
              }}
            >
              {email.body}
            </pre>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function EmailsPage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('all');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/emails?limit=200'));
      setError('');
    } catch (err) {
      setError(err.message);
      setData({ emails: [], counts: {} });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <LoadingPage label="Loading the outbox" />;

  const emails = status === 'all' ? data.emails : data.emails.filter((e) => e.status === status);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Outbox</h1>
          <p className="muted">
            Every message the system decided to send, whether or not it went out.
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          <Icon name="refresh" size={16} /> Refresh
        </button>
      </div>

      {error && <Banner kind="danger">{error}</Banner>}

      {data.delivery !== 'resend' && (
        <Banner kind="warn" title="Nothing is actually being sent">
          {data.delivery === 'disabled'
            ? 'Email delivery is switched off by USC_EMAIL_DISABLED.'
            : 'No mail provider is configured, so no message leaves the building.'}{' '}
          Messages are still composed and recorded here, so you can open one and send it
          by hand. Set <code>USC_EMAIL_API_KEY</code> and <code>USC_EMAIL_FROM</code> to
          have them delivered automatically.
        </Banner>
      )}

      <div className="grid grid-3" style={{ margin: '16px 0' }}>
        <Stat label="Sent" value={data.counts.sent || 0} foot="delivered to a provider" />
        <Stat
          label="To send by hand"
          value={data.counts.skipped || 0}
          foot="no provider configured"
          alert={(data.counts.skipped || 0) > 0}
        />
        <Stat
          label="Failed"
          value={data.counts.failed || 0}
          foot="provider rejected them"
          alert={(data.counts.failed || 0) > 0}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Segmented
          label="Delivery status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'skipped', label: 'To send' },
            { value: 'sent', label: 'Sent' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>

      {emails.length === 0 ? (
        <div className="card card-pad">
          <Empty icon="megaphone" title="Nothing here">
            Messages appear when an invoice is issued or a portal account is created.
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">To</th>
                <th scope="col">Subject</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap small muted">{fmtRelative(e.created_at)}</td>
                  <td>
                    <div>{e.to_name || e.to_email}</div>
                    {e.to_name && <div className="tiny muted mono">{e.to_email}</div>}
                  </td>
                  <td>{e.subject}</td>
                  <td className="small">{KIND_LABEL[e.kind] || e.kind}</td>
                  <td>
                    <Chip kind={STATUS_TONE[e.status]}>{e.status}</Chip>
                    {e.error && <div className="tiny muted">{e.error}</div>}
                  </td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => setOpen(e.id)}>
                      Read
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <MessageDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
