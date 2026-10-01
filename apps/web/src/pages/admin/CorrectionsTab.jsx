import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDateShort, fmtDateTime, fmtTime } from '../../lib/format.js';
import { Chip, Empty, Field, Modal, Segmented, useToast } from '../../components/ui.jsx';
import { formatDuration } from '@shared/domain.js';

const STATUS_KIND = { pending: 'warn', approved: 'ok', declined: 'danger', withdrawn: '' };

/** "06:00 → 05:51" when a time changes, the time alone when it does not. */
function Change({ from, to }) {
  if (!to) return <span>{from ? fmtTime(from) : '--'}</span>;
  return (
    <span>
      <s className="muted">{from ? fmtTime(from) : 'none'}</s> <strong>{fmtTime(to)}</strong>
    </span>
  );
}

function Decide({ correction, mode, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const approve = mode === 'approve';
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/time-corrections/${correction.id}/${mode}`, { note: note || null });
      toast.success(approve ? 'Approved. The shift has been corrected.' : 'Declined. The officer can see why.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={approve ? 'Approve the correction' : 'Decline the correction'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Back
          </button>
          <button className={`btn ${approve ? 'btn-primary' : 'btn-danger'}`} onClick={go} disabled={busy || (!approve && note.trim().length < 5)}>
            {busy ? 'Saving...' : approve ? 'Approve and correct the shift' : 'Decline'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          <strong>{correction.officer}</strong>, {correction.post_name} on {fmtDateShort(correction.recorded_clock_in_at)}.
        </div>
        <dl className="kv">
          <dt>Clock-in</dt>
          <dd>
            <Change from={correction.recorded_clock_in_at} to={correction.proposed_clock_in_at} />
          </dd>
          <dt>Clock-out</dt>
          <dd>
            <Change from={correction.recorded_clock_out_at} to={correction.proposed_clock_out_at} />
          </dd>
          <dt>Hours</dt>
          <dd>
            {formatDuration(correction.recorded_minutes ?? 0)} to {formatDuration(correction.proposed_minutes ?? 0)}
          </dd>
        </dl>
        <div className="small">
          <strong>They said:</strong> {correction.reason}
        </div>
        <Field
          label={approve ? 'Note (optional)' : 'Why not?'}
          hint={approve ? 'The recorded times are kept on the shift either way.' : 'The officer reads this.'}
        >
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Officers' requests to fix a punch: waiting ones first, oldest first, with
 * the times as recorded and as they should be. Supervisors see the queue;
 * an administrator decides, which corrects the shift.
 */
export default function CorrectionsTab({ onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const [status, setStatus] = useState('pending');
  const [data, setData] = useState(null);
  const [deciding, setDeciding] = useState(null);
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/time-corrections?status=${status}`));
    } catch (err) {
      toast.error(err.message);
      setData({ corrections: [], pending: 0 });
    }
  }, [status, toast]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="stack">
      <Segmented
        label="Which requests"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'pending', label: `Waiting ${data?.pending ?? ''}`.trim() },
          { value: 'all', label: 'All' },
        ]}
      />
      <div className="card">
        {!data ? (
          <div className="card-body small muted">Loading...</div>
        ) : data.corrections.length === 0 ? (
          <Empty icon="clock" title={status === 'pending' ? 'No corrections waiting' : 'No correction requests yet'}>
            Officers ask for a punch to be fixed from their schedule; their requests appear here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Officer</th>
                  <th>Shift</th>
                  <th>Clock-in</th>
                  <th>Clock-out</th>
                  <th>Why</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.corrections.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/admin/employees/${c.user_id}`} className="strong">
                        {c.officer}
                      </Link>
                      <div className="tiny muted">Asked {fmtDateTime(c.created_at)}</div>
                    </td>
                    <td className="small">
                      {fmtDateShort(c.recorded_clock_in_at)}
                      <div className="tiny muted">{c.post_name}</div>
                    </td>
                    <td className="small nowrap">
                      <Change from={c.recorded_clock_in_at} to={c.proposed_clock_in_at} />
                    </td>
                    <td className="small nowrap">
                      <Change from={c.recorded_clock_out_at} to={c.proposed_clock_out_at} />
                    </td>
                    <td className="small" style={{ maxWidth: 320 }}>
                      {c.reason}
                      {c.decision_note && <div className="tiny muted">Office: {c.decision_note}</div>}
                    </td>
                    <td>
                      <Chip kind={STATUS_KIND[c.status]}>{c.status_label}</Chip>
                      {c.decided_by_name && <div className="tiny muted">{c.decided_by_name}</div>}
                    </td>
                    <td className="num nowrap">
                      {c.status === 'pending' &&
                        (isAdmin ? (
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button className="btn btn-sm btn-primary" onClick={() => setDeciding({ c, mode: 'approve' })} aria-label={`Approve ${c.officer}'s correction`}>
                              Approve
                            </button>
                            <button className="btn btn-sm" onClick={() => setDeciding({ c, mode: 'decline' })} aria-label={`Decline ${c.officer}'s correction`}>
                              Decline
                            </button>
                          </div>
                        ) : (
                          <span className="tiny muted">An administrator decides</span>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {deciding && (
        <Decide
          correction={deciding.c}
          mode={deciding.mode}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
