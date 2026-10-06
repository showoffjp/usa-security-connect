import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../lib/api.js';
import { fmtDateTime, fmtDay } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, useToast } from '../../components/ui.jsx';

const STATUS = {
  open: ['warn', 'Waiting for us'],
  applied: ['ok', 'Changed'],
  declined: ['danger', 'Not changed'],
  withdrawn: ['', 'Withdrawn'],
};

function ChangeForm({ post, onSent, onCancel }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await clientApi.post('/client/post-orders/requests', { postId: post.id, body: text });
      toast.success('Sent. A supervisor will reply here and by email.');
      onSent(d.sites);
    } catch (err) {
      setError(err.fieldErrors?.body || err.message);
      setBusy(false);
    }
  };
  return (
    <form className="stack-sm" onSubmit={send} style={{ marginTop: 10 }}>
      <Field label="What should change?" required error={error} hint="What the officer should do differently, and why.">
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      </Field>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || text.trim().length < 10}>
          {busy ? 'Sending...' : 'Send request'}
        </button>
      </div>
    </form>
  );
}

function PostOrders({ post, onChange }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const withdraw = async (r) => {
    try {
      onChange((await clientApi.post(`/client/post-orders/requests/${r.id}/withdraw`)).sites);
      toast.success('Request withdrawn.');
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <li className="list-item" style={{ display: 'block', cursor: 'default' }}>
      <div className="row-between wrap" style={{ gap: 8 }}>
        <div>
          <strong className="small">{post.name}</strong> <span className="tiny muted">{post.post_code}</span>
          <div className="tiny muted">
            {post.order
              ? `Version ${post.order.version}, in force since ${fmtDay(post.order.created_at)}`
              : 'No written orders for this post yet'}
          </div>
        </div>
        {!asking && (
          <button className="btn btn-sm btn-ghost" onClick={() => setAsking(true)}>
            <Icon name="message" size={15} /> Ask for a change
          </button>
        )}
      </div>
      {post.training && (
        <div className="small" style={{ marginTop: 6 }}>
          <Chip kind="info">Site training</Chip>{' '}
          Only officers trained at this post work it alone: {post.training.trained} {post.training.trained === 1 ? 'is' : 'are'} trained now.
          {post.training.training_shifts > 0 &&
            ` ${post.training.training_shifts} shift${post.training.training_shifts === 1 ? '' : 's'} in the coming week ${post.training.training_shifts === 1 ? 'is a training shift' : 'are training shifts'} for an officer learning the post.`}
        </div>
      )}
      {post.order?.change_note && post.order.version > 1 && (
        <div className="small" style={{ marginTop: 6 }}>
          <strong>Latest change:</strong> {post.order.change_note}
        </div>
      )}
      {post.order && (
        <details style={{ marginTop: 6 }}>
          <summary className="small strong" style={{ cursor: 'pointer', color: 'var(--navy-700)' }}>
            Read the orders
          </summary>
          <div className="small" style={{ whiteSpace: 'pre-line', marginTop: 6, color: 'var(--ink-3)' }}>
            {post.order.body}
          </div>
        </details>
      )}
      {asking && (
        <ChangeForm
          post={post}
          onCancel={() => setAsking(false)}
          onSent={(sites) => {
            setAsking(false);
            onChange(sites);
          }}
        />
      )}
      {post.requests.length > 0 && (
        <ul className="list order-requests" aria-label={`Changes asked for at ${post.name}`}>
          {post.requests.map((r) => {
            const [kind, label] = STATUS[r.status] || ['', r.status];
            return (
              <li key={r.id} className="row" style={{ alignItems: 'flex-start', gap: 10, padding: '8px 0' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Chip kind={kind}>
                      {label}
                      {r.status === 'applied' && r.applied_version ? ` in version ${r.applied_version}` : ''}
                    </Chip>
                    <span className="tiny muted">
                      {r.mine ? 'You asked' : 'A colleague asked'} {fmtDateTime(r.created_at)}
                    </span>
                  </div>
                  <div className="small" style={{ marginTop: 3 }}>{r.body}</div>
                  {r.response && (
                    <div className="small" style={{ marginTop: 3 }}>
                      <strong>Our reply:</strong> {r.response}
                    </div>
                  )}
                </div>
                {r.status === 'open' && r.mine && (
                  <button className="btn btn-sm btn-ghost" onClick={() => withdraw(r)}>
                    Withdraw
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * The standing orders our officers work to at each of the client's posts,
 * and a way to ask for them to change.
 */
export default function PortalOrders() {
  const [sites, setSites] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setSites((await clientApi.get('/client/post-orders')).sites);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1>Post orders</h1>
        <p className="muted">
          What our officers are instructed to do at each post. Every officer who works a post reads and acknowledges the
          current version. Ask for a change and a supervisor will reply here.
        </p>
      </div>
      {error && (
        <Banner kind="danger" title="Post orders did not load">
          {error}
        </Banner>
      )}
      {!sites && !error ? (
        <LoadingPage label="Loading post orders" />
      ) : sites ? (
        sites.map((site) => (
          <div key={site.id} className="card">
            <div className="card-head">
              <h2 className="h3">{site.name}</h2>
              <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                {site.posts.length} post{site.posts.length === 1 ? '' : 's'}
              </span>
            </div>
            {site.posts.length === 0 ? (
              <Empty icon="clipboard" title="No posts at this property" />
            ) : (
              <ul className="list">
                {site.posts.map((p) => (
                  <PostOrders key={p.id} post={p} onChange={setSites} />
                ))}
              </ul>
            )}
          </div>
        ))
      ) : null}
    </div>
  );
}
