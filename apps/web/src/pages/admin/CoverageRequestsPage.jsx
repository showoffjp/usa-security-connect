import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtTime } from '../../lib/format.js';
import { LoadingPage, Empty, Chip, Modal, Field, Segmented, useToast } from '../../components/ui.jsx';

const STATUS = {
  open: ['warn', 'Waiting'],
  scheduled: ['ok', 'Scheduled'],
  declined: ['danger', 'Declined'],
  cancelled: ['', 'Withdrawn by client'],
};

const hoursBetween = (a, b) => Math.round(((new Date(b) - new Date(a)) / 3600000) * 10) / 10;

function AnswerDialog({ request, posts, mode, onClose, onDone }) {
  const toast = useToast();
  const choices = posts.filter((p) => p.site_id === request.site_id && (!request.armed || p.armed));
  const [postId, setPostId] = useState(choices[0]?.id ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scheduling = mode === 'schedule';

  const submit = async () => {
    setBusy(true);
    try {
      if (scheduling) {
        await api.post(`/admin/coverage-requests/${request.id}/schedule`, { postId: Number(postId), note: text || null });
        toast.success(`${request.officers} open shift${request.officers === 1 ? '' : 's'} added to the schedule. The client has been told.`);
      } else {
        await api.post(`/admin/coverage-requests/${request.id}/decline`, { response: text });
        toast.success('Declined. The client has been told.');
      }
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={scheduling ? 'Schedule this coverage' : 'Decline this request'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={scheduling ? 'btn btn-primary' : 'btn btn-danger'}
            onClick={submit}
            disabled={busy || (scheduling ? !postId : text.trim().length < 5)}
          >
            {busy ? 'Saving...' : scheduling ? `Add ${request.officers} open shift${request.officers === 1 ? '' : 's'}` : 'Decline'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          <strong>{request.site_name}</strong> · {fmtDateTime(request.starts_at)} to {fmtTime(request.ends_at)} ·{' '}
          {request.officers} officer{request.officers === 1 ? '' : 's'}
          {request.armed ? ', armed' : ''}
          <div className="muted" style={{ marginTop: 4 }}>{request.reason}</div>
        </div>
        {scheduling ? (
          <>
            {choices.length === 0 ? (
              <p className="small" style={{ color: 'var(--danger)', margin: 0 }}>
                This site has no {request.armed ? 'armed ' : ''}post to put the shifts on. Add one under Sites &amp; posts, or
                decline the request.
              </p>
            ) : (
              <Field label="Post" required hint="The shifts go on the schedule unassigned, for you to staff.">
                <select value={postId} onChange={(e) => setPostId(e.target.value)}>
                  {choices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.post_code ? ` (${p.post_code})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Note to the client" hint="Optional. Sent with the confirmation.">
              <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
            </Field>
          </>
        ) : (
          <Field label="Why - the client will see this" required>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export default function CoverageRequestsPage() {
  const toast = useToast();
  const [tab, setTab] = useState('open');
  const [data, setData] = useState(null);
  const [answering, setAnswering] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/admin/coverage-requests?status=${tab}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { requests: [], posts: [] });
    }
  }, [tab, toast]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Workforce</div>
        <h1>Client requests</h1>
        <p className="lead">Extra coverage clients have asked for from the portal. Schedule them as open shifts, or decline with a reason.</p>
      </div>

      <div className="card">
        <div className="card-head wrap">
          <Segmented
            label="Show"
            value={tab}
            onChange={(v) => {
              setData(null);
              setTab(v);
            }}
            options={[
              { value: 'open', label: 'Waiting' },
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'declined', label: 'Declined' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Link className="small" to="/admin/schedule">
            Open the schedule
          </Link>
        </div>
        {!data ? (
          <LoadingPage label="Loading requests" />
        ) : data.requests.length === 0 ? (
          <Empty icon="calendar" title={tab === 'open' ? 'Nothing waiting' : 'No requests here'}>
            {tab === 'open' ? 'New requests from clients appear here.' : null}
          </Empty>
        ) : (
          <ul className="list">
            {data.requests.map((r) => {
              const [kind, label] = STATUS[r.status] || ['', r.status];
              return (
                <li key={r.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className="strong">{r.site_name}</span>
                      <Chip kind={kind}>{label}</Chip>
                      {r.armed && <Chip kind="warn">Armed</Chip>}
                    </div>
                    <div className="small" style={{ marginTop: 3 }}>
                      {fmtDateTime(r.starts_at)} to {fmtTime(r.ends_at)} · {hoursBetween(r.starts_at, r.ends_at)}h ·{' '}
                      <strong>
                        {r.officers} officer{r.officers === 1 ? '' : 's'}
                      </strong>
                    </div>
                    <div className="small muted" style={{ marginTop: 3 }}>{r.reason}</div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      Asked by {r.client_name || 'a client contact'}
                      {r.client_company ? ` (${r.client_company})` : ''} · {fmtDateTime(r.created_at)}
                      {r.handled_by_name ? ` · answered by ${r.handled_by_name} ${fmtDateTime(r.handled_at)}` : ''}
                      {r.post_name ? ` · ${r.shifts_created} shift${r.shifts_created === 1 ? '' : 's'} on ${r.post_name}` : ''}
                    </div>
                    {r.response && <div className="small" style={{ marginTop: 4 }}>Reply: {r.response}</div>}
                  </div>
                  {r.status === 'open' && (
                    <div className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setAnswering({ request: r, mode: 'decline' })}>
                        Decline
                      </button>
                      <button className="btn btn-sm btn-navy" onClick={() => setAnswering({ request: r, mode: 'schedule' })}>
                        Schedule
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {answering && (
        <AnswerDialog
          request={answering.request}
          mode={answering.mode}
          posts={data?.posts || []}
          onClose={() => setAnswering(null)}
          onDone={() => {
            setAnswering(null);
            load();
          }}
        />
      )}
    </div>
  );
}
