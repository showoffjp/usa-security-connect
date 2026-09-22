import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDate, fmtRelative } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Modal, Field, Banner, Segmented, useToast,
} from '../../components/ui.jsx';
import { TIME_OFF_LABEL } from '@shared/domain.js';

function DecisionDialog({ request, decision, onClose, onSaved }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const approving = decision === 'approved';

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.patch(`/time-off/${request.id}`, { status: decision, note: note.trim() || undefined });
      toast.success(
        res.shiftsToRecover > 0
          ? `Approved. ${res.shiftsToRecover} scheduled shift${res.shiftsToRecover === 1 ? '' : 's'} still need covering.`
          : `Request ${decision}.`
      );
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const days =
    Math.round((new Date(request.ends_on) - new Date(request.starts_on)) / 86400000) + 1;

  return (
    <Modal
      title={`${approving ? 'Approve' : 'Deny'} time off`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${approving ? 'btn-primary' : 'btn-danger'}`}
            onClick={save}
            disabled={busy}
          >
            {approving ? 'Approve' : 'Deny'}
          </button>
        </>
      }
    >
      <div className="stack">
        <dl className="kv">
          <dt>Officer</dt>
          <dd>{request.officer}</dd>
          <dt>Type</dt>
          <dd>{TIME_OFF_LABEL[request.type] || request.type}</dd>
          <dt>Dates</dt>
          <dd>
            {fmtDate(request.starts_on)} to {fmtDate(request.ends_on)}{' '}
            <span className="muted">({days} day{days === 1 ? '' : 's'})</span>
          </dd>
          {request.reason && (
            <>
              <dt>Reason</dt>
              <dd>{request.reason}</dd>
            </>
          )}
        </dl>

        {approving && (
          <Banner kind="warn">
            Approving does not unassign their shifts - the roster still needs re-covering, and the
            count is shown once you approve.
          </Banner>
        )}

        <Field label="Note to the officer" hint="Optional, but a denial without a reason invites a follow-up.">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

export default function TimeOffPage() {
  const toast = useToast();
  const [requests, setRequests] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [decision, setDecision] = useState(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ scope: 'all' });
      if (filter !== 'all') qs.set('status', filter);
      setRequests((await api.get(`/time-off?${qs}`)).requests);
    } catch (err) {
      toast.error(err.message);
      setRequests([]);
    }
  }, [filter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!requests) return <LoadingPage label="Loading requests" />;

  const pending = requests.filter((r) => r.status === 'pending');
  const upcoming = requests.filter(
    (r) => r.status === 'approved' && new Date(r.ends_on) >= new Date()
  );

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">Workforce</div>
        <h1>Time off</h1>
        <p className="lead">Requests from officers, and who is already booked off.</p>
      </div>

      <div className="grid grid-3">
        <Stat label="Awaiting decision" value={pending.length} foot="Officers are waiting" alert={pending.length > 0} />
        <Stat label="Approved upcoming" value={upcoming.length} foot="Plan cover for these" />
        <Stat label="Total shown" value={requests.length} foot="Current filter" />
      </div>

      <Segmented
          label="Time-off status"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'approved', label: 'Approved' },
          { value: 'denied', label: 'Denied' },
          { value: 'all', label: 'All' },
        ]}
      />

      <div className="card">
        {requests.length === 0 ? (
          <Empty icon="calendar" title="Nothing to show">
            Officers request time off from the mobile app.
          </Empty>
        ) : (
          <div className="list">
            {requests.map((r) => {
              const days = Math.round((new Date(r.ends_on) - new Date(r.starts_on)) / 86400000) + 1;
              return (
                <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
                  <div className="lead-icon">
                    <Icon name="calendar" size={18} />
                  </div>
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 7 }}>
                      <Link to={`/admin/employees/${r.user_id}`} className="strong small">
                        {r.officer}
                      </Link>
                      <Chip kind="navy">{TIME_OFF_LABEL[r.type] || r.type}</Chip>
                      <StatusChip value={r.status} />
                    </div>
                    <div className="small">
                      {fmtDate(r.starts_on)} - {fmtDate(r.ends_on)}{' '}
                      <span className="muted">
                        ({days} day{days === 1 ? '' : 's'})
                      </span>
                    </div>
                    {r.reason && <div className="tiny muted">{r.reason}</div>}
                    <div className="tiny muted">Requested {fmtRelative(r.created_at)}</div>
                    {r.decision_note && (
                      <div className="tiny" style={{ color: 'var(--ink-3)' }}>
                        {r.decided_by_name}: {r.decision_note}
                      </div>
                    )}
                  </div>
                  {r.status === 'pending' && (
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setDecision({ request: r, decision: 'denied' })}
                      >
                        Deny
                      </button>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => setDecision({ request: r, decision: 'approved' })}
                      >
                        Approve
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {decision && (
        <DecisionDialog
          request={decision.request}
          decision={decision.decision}
          onClose={() => setDecision(null)}
          onSaved={() => {
            setDecision(null);
            load();
          }}
        />
      )}
    </div>
  );
}
