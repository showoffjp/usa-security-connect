import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDay, fmtRange, fmtRelative, fmtDate } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Modal, Field, Banner, Segmented, useToast,
} from '../../components/ui.jsx';
import { SHIFT_REQUEST_LABEL } from '@shared/domain.js';

/** What actually changes on the roster if this is approved. */
function Outcome({ request }) {
  if (request.kind === 'drop') {
    return (
      <>
        <strong>{request.requested_by_name}</strong> comes off the shift and it reopens for anyone to claim.
      </>
    );
  }
  if (request.kind === 'claim') {
    return (
      <>
        The shift is assigned to <strong>{request.requested_by_name}</strong>. Any competing claim is closed.
      </>
    );
  }
  return (
    <>
      <strong>{request.target_name}</strong> takes the shift from <strong>{request.requested_by_name}</strong>
      {request.offered_starts_at ? (
        <>
          , and <strong>{request.requested_by_name}</strong> picks up their{' '}
          {fmtDay(request.offered_starts_at)} {request.offered_post_name} shift in return
        </>
      ) : null}
      .
    </>
  );
}

function DecisionDialog({ request, decision, onClose, onSaved }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(null);
  const approving = decision === 'approved';

  const save = async () => {
    setBusy(true);
    setBlocked(null);
    try {
      await api.patch(`/shifts/requests/${request.id}`, {
        status: decision,
        note: note.trim() || undefined,
      });
      toast.success(approving ? 'Roster updated.' : 'Request denied.');
      onSaved();
    } catch (err) {
      // Eligibility is re-checked at approval, so the roster may have moved.
      if (err.details?.reasons) setBlocked(err.details.reasons);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${approving ? 'Approve' : 'Deny'} ${SHIFT_REQUEST_LABEL[request.kind].toLowerCase()}`}
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
        {blocked && (
          <Banner kind="danger" title="No longer possible">
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {blocked.map((r, i) => (
                <li key={i} className="small">
                  {r.message}
                </li>
              ))}
            </ul>
          </Banner>
        )}

        <dl className="kv">
          <dt>Shift</dt>
          <dd>
            {request.post_name} &middot; {request.site_name}
            {request.armed && <Chip kind="danger">Armed</Chip>}
          </dd>
          <dt>When</dt>
          <dd>
            {fmtDay(request.starts_at)}, {fmtRange(request.starts_at, request.ends_at)}
          </dd>
          <dt>Requested by</dt>
          <dd>{request.requested_by_name}</dd>
          {request.note && (
            <>
              <dt>Their note</dt>
              <dd>{request.note}</dd>
            </>
          )}
        </dl>

        {approving && (
          <Banner kind="info" title="What this does">
            <Outcome request={request} />
          </Banner>
        )}

        <Field label="Note to the officer" hint="Optional for an approval; worth writing for a denial.">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

export default function ShiftRequestsPage() {
  const toast = useToast();
  const [requests, setRequests] = useState(null);
  const [filter, setFilter] = useState('open');
  const [decision, setDecision] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/shifts/requests?scope=all');
      setRequests(res.requests);
    } catch (err) {
      toast.error(err.message);
      setRequests([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    if (!requests) return [];
    if (filter === 'all') return requests;
    if (filter === 'open') return requests.filter((r) => ['pending', 'accepted'].includes(r.status));
    return requests.filter((r) => r.status === filter);
  }, [requests, filter]);

  if (!requests) return <LoadingPage label="Loading requests" />;

  const awaitingSupervisor = requests.filter(
    (r) => r.status === 'accepted' || (r.status === 'pending' && r.kind !== 'swap')
  );
  const awaitingOfficer = requests.filter((r) => r.status === 'pending' && r.kind === 'swap');

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">Workforce</div>
        <h1>Shift requests</h1>
        <p className="lead">
          Open shifts officers want, swaps they have agreed between themselves, and shifts they need to drop.
        </p>
      </div>

      <div className="grid grid-3">
        <Stat
          label="Needs your decision"
          value={awaitingSupervisor.length}
          foot="Claims, drops, agreed swaps"
          alert={awaitingSupervisor.length > 0}
        />
        <Stat label="Waiting on an officer" value={awaitingOfficer.length} foot="Swap not yet accepted" />
        <Stat label="Total" value={requests.length} foot="All time" />
      </div>

      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'approved', label: 'Approved' },
          { value: 'denied', label: 'Denied' },
          { value: 'all', label: 'All' },
        ]}
      />

      <div className="card">
        {shown.length === 0 ? (
          <Empty icon="calendar" title="Nothing here">
            Officers claim open shifts and propose swaps from the mobile app.
          </Empty>
        ) : (
          <div className="list">
            {shown.map((r) => {
              const needsSupervisor = r.status === 'accepted' || (r.status === 'pending' && r.kind !== 'swap');
              return (
                <div key={r.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                  <div
                    className="lead-icon"
                    style={
                      r.kind === 'drop'
                        ? { background: 'var(--warn-bg)', color: 'var(--warn)' }
                        : r.kind === 'swap'
                          ? { background: 'var(--navy-100)', color: 'var(--navy-700)' }
                          : { background: 'var(--brand-100)', color: 'var(--brand-600)' }
                    }
                  >
                    <Icon name={r.kind === 'swap' ? 'route' : r.kind === 'drop' ? 'x' : 'plus'} size={18} />
                  </div>

                  <div className="grow">
                    <div className="row wrap" style={{ gap: 7 }}>
                      <span className="strong small">{SHIFT_REQUEST_LABEL[r.kind]}</span>
                      <StatusChip value={r.status} />
                      {r.armed && <Chip kind="danger">Armed post</Chip>}
                    </div>

                    <div className="small" style={{ marginTop: 2 }}>
                      {r.post_name} &middot; {r.site_name} &middot; {fmtDay(r.starts_at)}{' '}
                      {fmtRange(r.starts_at, r.ends_at)}
                    </div>

                    <div className="tiny muted">
                      <Link to={`/admin/employees/${r.requested_by}`}>{r.requested_by_name}</Link>
                      {r.target_name && <> &rarr; {r.target_name}</>}
                      {' '}&middot; {fmtRelative(r.created_at)}
                    </div>

                    {r.note && <div className="tiny" style={{ color: 'var(--ink-3)' }}>&ldquo;{r.note}&rdquo;</div>}

                    {r.offered_starts_at && (
                      <div className="tiny muted">
                        In return: {fmtDay(r.offered_starts_at)} {r.offered_post_name}
                      </div>
                    )}

                    {r.decision_note && (
                      <div className="tiny" style={{ color: 'var(--ink-3)' }}>
                        {r.decided_by_name}: {r.decision_note}
                      </div>
                    )}
                  </div>

                  {needsSupervisor ? (
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
                  ) : r.status === 'pending' ? (
                    <Chip kind="warn">Waiting on {r.target_name}</Chip>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
