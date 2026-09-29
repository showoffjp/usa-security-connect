import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/format.js';
import { Chip, Empty, Field, LoadingPage, Modal, Segmented, Stat, useToast } from '../../components/ui.jsx';
import { CsvButton } from './SiteLogAdmin.jsx';

const monthName = (p) => {
  const [y, m] = p.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};
export const Stars = ({ n }) => (
  <span aria-label={`${n} out of 5`} style={{ color: n <= 2 ? 'var(--danger)' : n === 3 ? 'var(--warn)' : 'var(--ok)', letterSpacing: 1 }}>
    {'★'.repeat(n)}
    <span style={{ color: 'var(--line-2)' }}>{'★'.repeat(5 - n)}</span>
  </span>
);

function ReplyDialog({ item, onClose, onDone }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/feedback/${item.id}/respond`, { response: text });
      toast.success('Reply sent. The client sees it in the portal.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Reply to ${item.client_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={send} disabled={busy || text.trim().length < 5}>
            {busy ? 'Sending...' : 'Send reply'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          <Stars n={item.rating} /> {item.site_name}, {monthName(item.period)}
          {item.comment && <div style={{ marginTop: 4 }}>&ldquo;{item.comment}&rdquo;</div>}
        </div>
        <Field label="Your reply" required hint="What you have done about it. The client reads this in their portal.">
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * What clients think of the service, month by month. A rating of two or
 * under without a reply is a client thinking about leaving, so those lead.
 */
export default function FeedbackPage() {
  const toast = useToast();
  const [months, setMonths] = useState('6');
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState(null);
  const [replying, setReplying] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/admin/feedback?months=${months}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { feedback: [], sites: [], byMonth: [] });
    }
  }, [months, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const rows = !data
    ? []
    : filter === 'reply'
      ? data.feedback.filter((f) => f.rating <= 2 && !f.response)
      : filter === 'comments'
        ? data.feedback.filter((f) => f.comment)
        : data.feedback;

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Clients</div>
        <h1>Client feedback</h1>
        <p className="lead">How each client rates the service at each property, month by month, and what they said.</p>
      </div>

      <div className="row wrap" style={{ gap: 10 }}>
        <Segmented
          label="Period"
          value={months}
          onChange={setMonths}
          options={[
            { value: '3', label: '3 months' },
            { value: '6', label: '6 months' },
            { value: '12', label: '12 months' },
          ]}
        />
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All ratings' },
            { value: 'reply', label: `Needs a reply${data?.needsReply ? ` (${data.needsReply})` : ''}` },
            { value: 'comments', label: 'With comments' },
          ]}
        />
        <CsvButton path={`/admin/feedback?months=${months}`} filename={`client-feedback-${months}-months`} />
      </div>

      {!data ? (
        <LoadingPage label="Loading feedback" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Average rating" value={data.average ?? '--'} foot={`${data.feedback.length} ratings`} />
            <Stat label="Needs a reply" value={data.needsReply} foot="Two stars or fewer" alert={data.needsReply > 0} />
            <Stat
              label="Lowest property"
              value={data.sites[0]?.average ?? '--'}
              foot={data.sites[0]?.site_name || 'No ratings yet'}
              alert={data.sites[0]?.average != null && data.sites[0].average < 3.5}
            />
            <Stat
              label="This month"
              value={data.byMonth.at(-1)?.average ?? '--'}
              foot={data.byMonth.at(-1) ? `${data.byMonth.at(-1).count} so far` : 'No ratings yet'}
            />
          </div>

          <div className="card">
            {rows.length === 0 ? (
              <Empty icon="users" title={filter === 'reply' ? 'Nothing waiting for a reply' : 'No ratings in this period'} />
            ) : (
              <ul className="list">
                {rows.map((f) => (
                  <li key={f.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                    <div className="grow">
                      <div className="row wrap" style={{ gap: 8 }}>
                        <Stars n={f.rating} />
                        <span className="strong small">{f.site_name}</span>
                        <span className="tiny muted">
                          {f.client_name}
                          {f.client_company ? `, ${f.client_company}` : ''} · {monthName(f.period)}
                        </span>
                        {f.rating <= 2 && !f.response && <Chip kind="danger">Needs a reply</Chip>}
                      </div>
                      {f.comment && <div className="small" style={{ marginTop: 4 }}>&ldquo;{f.comment}&rdquo;</div>}
                      {f.response && (
                        <div className="small" style={{ marginTop: 6 }}>
                          <strong>Our reply:</strong> {f.response}
                          <span className="tiny muted">
                            {' '}
                            ({f.responded_by_name}, {fmtDateTime(f.responded_at)})
                          </span>
                        </div>
                      )}
                    </div>
                    {!f.response && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setReplying(f)}>
                        Reply
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {replying && (
        <ReplyDialog
          item={replying}
          onClose={() => setReplying(null)}
          onDone={() => {
            setReplying(null);
            load();
          }}
        />
      )}
    </div>
  );
}
