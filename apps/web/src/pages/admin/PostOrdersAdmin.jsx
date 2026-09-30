import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, useToast } from '../../components/ui.jsx';

function ReviseDialog({ post, request, onClose, onDone }) {
  const toast = useToast();
  const [body, setBody] = useState(post.order?.body || '');
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const unchanged = body.trim() === (post.order?.body || '').trim();
  const save = async () => {
    setBusy(true);
    try {
      const d = await api.post('/post-log/admin/orders', {
        postId: post.id, body, changeNote: note || null, requestId: request?.id ?? null, response: reply || null,
      });
      toast.success(
        `Version ${d.order.version} issued. Officers on this post are asked to acknowledge it${request ? ', and the client is told' : ''}.`
      );
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={post.order ? `New orders for ${post.name}` : `Orders for ${post.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || unchanged || body.trim().length < 10}>
            {busy ? 'Issuing...' : post.order ? `Issue version ${post.order.version + 1}` : 'Issue orders'}
          </button>
        </>
      }
    >
      <div className="stack">
        {request && (
          <Banner kind="info" title={`${request.client_name || 'The client'} asked`}>
            {request.body}
          </Banner>
        )}
        <div className="small muted">
          {post.site_name}. The current version stays on record; every officer who works this post is asked to read and
          acknowledge the new one.
        </div>
        <Field label="Post orders" required>
          <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
        </Field>
        <Field label="What changed" hint="One line officers see above the orders, e.g. 'North doors now lock at 18:00'.">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
        {request && (
          <Field label="Reply to the client" hint="Optional. They read it in the portal and by email with the change.">
            <textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={1000} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function DeclineDialog({ post, request, onClose, onDone }) {
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/post-log/admin/order-requests/${request.id}/decline`, { response: reply });
      toast.success('Declined. The client has your reply.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Decline the change at ${post.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={send} disabled={busy || reply.trim().length < 5}>
            {busy ? 'Sending...' : 'Decline and reply'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner kind="info" title={`${request.client_name || 'The client'} asked`}>
          {request.body}
        </Banner>
        <Field label="Why not" required hint="The client reads this in the portal and by email.">
          <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

function HistoryDialog({ post, onClose }) {
  const toast = useToast();
  const [versions, setVersions] = useState(null);
  useEffect(() => {
    api.get(`/post-log/admin/orders/${post.id}/history`).then(
      (d) => setVersions(d.versions),
      (err) => {
        toast.error(err.message);
        setVersions([]);
      }
    );
  }, [post.id, toast]);
  return (
    <Modal wide title={`Order history: ${post.name}`} onClose={onClose}>
      {!versions ? (
        <LoadingPage label="Loading" />
      ) : versions.length === 0 ? (
        <Empty icon="clipboard" title="No orders issued for this post yet" />
      ) : (
        <ol className="list">
          {versions.map((v, i) => (
            <li key={v.id} className="list-item" style={{ display: 'block', cursor: 'default' }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <strong className="small">Version {v.version}</strong>
                {i === 0 && <Chip kind="ok">In force</Chip>}
                <span className="tiny muted">
                  {fmtDateTime(v.created_at)}
                  {v.author_name ? `, ${v.author_name}` : ''} · {v.acks} acknowledged
                </span>
              </div>
              {v.change_note && <div className="small" style={{ marginTop: 4 }}>{v.change_note}</div>}
              <details style={{ marginTop: 4 }} open={i === 0}>
                <summary className="tiny" style={{ cursor: 'pointer' }}>
                  The orders
                </summary>
                <div className="small" style={{ whiteSpace: 'pre-line', color: 'var(--ink-3)', marginTop: 4 }}>
                  {v.body || <em>Orders withdrawn</em>}
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

/**
 * Every post's standing orders, and who has not yet acknowledged the
 * version in force. Issuing a new version keeps the old one on record.
 */
export function OrdersAdmin({ sites, siteId, setSiteId }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [revising, setRevising] = useState(null);
  const [history, setHistory] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [onlyOutstanding, setOnlyOutstanding] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/post-log/admin/orders${siteId ? `?siteId=${siteId}` : ''}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { posts: [], outstandingTotal: 0 });
    }
  }, [siteId, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const posts = !data ? [] : onlyOutstanding ? data.posts.filter((p) => p.outstanding.length || p.requests?.length) : data.posts;

  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: 'auto', maxWidth: 300 }}>
          <option value="">All sites</option>
          {sites.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={onlyOutstanding} onChange={(e) => setOnlyOutstanding(e.target.checked)} />
          Only posts needing attention
        </label>
        {data && (
          <span className="small muted">
            {data.requestsTotal ? `${data.requestsTotal} client request${data.requestsTotal === 1 ? '' : 's'} · ` : ''}
            {data.outstandingTotal ? `${data.outstandingTotal} acknowledgement${data.outstandingTotal === 1 ? '' : 's'} outstanding` : 'Everyone is up to date'}
          </span>
        )}
      </div>
      {!data ? (
        <LoadingPage label="Loading post orders" />
      ) : posts.length === 0 ? (
        <Empty icon="clipboard" title={onlyOutstanding ? 'Nothing waiting: every officer has read the orders in force' : 'No posts here'} />
      ) : (
        <ul className="list">
          {posts.map((p) => (
            <li key={p.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
              <div className="grow">
                <div className="row wrap" style={{ gap: 8 }}>
                  <strong className="small">{p.name}</strong>
                  <span className="tiny muted">
                    {p.post_code} · {p.site_name}
                  </span>
                  {p.order ? (
                    <Chip>v{p.order.version}</Chip>
                  ) : (
                    <Chip kind="warn">No orders</Chip>
                  )}
                </div>
                {p.order && (
                  <div className="tiny muted" style={{ marginTop: 2 }}>
                    Issued {fmtDateTime(p.order.created_at)}
                    {p.order.change_note ? `: ${p.order.change_note}` : ''}
                  </div>
                )}
                {p.order && (
                  <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                    {p.acked.length > 0 && (
                      <span className="tiny" title={p.acked.map((a) => a.name).join(', ')}>
                        <Icon name="check" size={13} /> {p.acked.length} acknowledged
                      </span>
                    )}
                    {p.outstanding.map((o) => (
                      <Chip key={o.id} kind="warn">
                        {o.name} has not read it
                      </Chip>
                    ))}
                  </div>
                )}
                {p.requests?.map((r) => (
                  <div key={r.id} className="order-request">
                    <div className="small">
                      <strong>
                        {r.client_name || 'A client'}
                        {r.client_company ? ` (${r.client_company})` : ''} asked
                      </strong>{' '}
                      <span className="tiny muted">{fmtDateTime(r.created_at)}</span>
                    </div>
                    <div className="small" style={{ marginTop: 2 }}>{r.body}</div>
                    <div className="row" style={{ gap: 6, marginTop: 6 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => setRevising({ post: p, request: r })}>
                        Apply as a new version
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setDeclining({ post: p, request: r })}>
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {p.order && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setHistory(p)}>
                    History
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => setRevising({ post: p })}>
                  {p.order ? 'New version' : 'Write orders'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {revising && (
        <ReviseDialog
          post={revising.post}
          request={revising.request}
          onClose={() => setRevising(null)}
          onDone={() => {
            setRevising(null);
            load();
          }}
        />
      )}
      {history && <HistoryDialog post={history} onClose={() => setHistory(null)} />}
      {declining && (
        <DeclineDialog
          post={declining.post}
          request={declining.request}
          onClose={() => setDeclining(null)}
          onDone={() => {
            setDeclining(null);
            load();
          }}
        />
      )}
    </div>
  );
}
