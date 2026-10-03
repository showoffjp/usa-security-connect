import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime, fmtMoney } from '../../lib/format.js';
import { Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, Stat, useToast } from '../../components/ui.jsx';
import { ReceiptView } from '../../components/ReceiptView.jsx';
import { EXPENSE_CHIP, fmtPaidIn } from '../officer/MyExpenses.jsx';

const cents = (dollars) => fmtMoney(Math.round((dollars || 0) * 100));

function DecideDialog({ claim, approve, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/expenses/${claim.id}/${approve ? 'approve' : 'decline'}`, { note: note.trim() || undefined });
      toast.success(approve ? `Approved. ${claim.officer} is paid with the next payroll.` : `Declined. ${claim.officer} can read why.`);
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={approve ? 'Approve this claim' : 'Decline this claim'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={approve ? 'btn btn-primary' : 'btn btn-danger'} onClick={submit} disabled={busy || (!approve && note.trim().length < 5)}>
            {busy ? 'Saving...' : approve ? `Approve ${cents(claim.amount)}` : 'Decline'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          <strong>{claim.officer}</strong> · {claim.category_label} · {cents(claim.amount)} · {fmtDate(claim.incurred_on)}
          <div className="muted" style={{ marginTop: 4 }}>{claim.description}</div>
        </div>
        <Field label={approve ? 'Note to the officer' : 'Why - the officer will see this'} required={!approve} hint={approve ? 'Optional.' : undefined}>
          <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Expense claims from officers: the queue, the receipts, the decisions. */
export default function ExpensesPage() {
  const toast = useToast();
  const { user, isAdmin } = useAuth();
  const [tab, setTab] = useState('pending');
  const [data, setData] = useState(null);
  const [deciding, setDeciding] = useState(null);
  const [receipt, setReceipt] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/expenses${tab === 'all' ? '' : `?status=${tab}`}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { claims: [], summary: {}, rules: {} });
    }
  }, [tab, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const s = data?.summary || {};
  const stat = (k) => s[k] || { count: 0, amount: 0 };

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Workforce</div>
        <h1>Expenses</h1>
        <p className="lead">
          What officers spent on the job and want back: parking, tolls, supplies, miles in their own car. Approved claims are paid with the next
          payroll close{isAdmin ? '' : '; an administrator decides them'}.
        </p>
      </div>

      {data && (
        <div className="grid grid-4">
          <Stat label="Waiting" value={stat('pending').count} foot={cents(stat('pending').amount)} alert={stat('pending').count > 0} />
          <Stat label="Approved, to pay" value={cents(stat('approved').amount)} foot={`${stat('approved').count} claim${stat('approved').count === 1 ? '' : 's'}`} />
          <Stat label="Paid" value={cents(stat('paid').amount)} foot={`${stat('paid').count} claim${stat('paid').count === 1 ? '' : 's'}`} />
          <Stat label="Declined" value={stat('declined').count} foot={cents(stat('declined').amount)} />
        </div>
      )}

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
              { value: 'pending', label: 'Waiting' },
              { value: 'approved', label: 'Approved' },
              { value: 'paid', label: 'Paid' },
              { value: 'declined', label: 'Declined' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Link className="small" to="/admin/payroll">
            Payroll
          </Link>
        </div>
        {!data ? (
          <LoadingPage label="Loading claims" />
        ) : data.claims.length === 0 ? (
          <Empty icon="dollar" title={tab === 'pending' ? 'Nothing waiting' : 'No claims here'}>
            {tab === 'pending' ? 'New claims from officers appear here.' : null}
          </Empty>
        ) : (
          <ul className="list">
            {data.claims.map((c) => {
              const mine = c.user_id === user?.id;
              return (
                <li key={c.id} className="list-item expense-row" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                  <div className="lead-icon">
                    <Icon name={c.category === 'mileage' ? 'car' : 'dollar'} size={17} />
                  </div>
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className="strong">{c.officer}</span>
                      <span className="strong">{cents(c.amount)}</span>
                      <Chip kind={EXPENSE_CHIP[c.status]}>{c.status_label}</Chip>
                    </div>
                    <div className="small" style={{ marginTop: 3 }}>
                      {c.category_label}
                      {c.miles != null ? ` · ${c.miles} mi at ${data.rules.mileageRateCents}¢` : ''} · {fmtDate(c.incurred_on)}
                      {c.site_name ? ` · ${c.site_name}` : ''}
                    </div>
                    <div className="small muted" style={{ marginTop: 3 }}>{c.description}</div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      #{c.employee_code} · claimed {fmtDateTime(c.created_at)}
                      {c.decided_by ? ` · ${c.status === 'declined' ? 'declined' : 'approved'} by ${c.decided_by} ${fmtDateTime(c.decided_at)}` : ''}
                      {c.paid_in ? ` · paid with ${fmtPaidIn(c.paid_in)}` : ''}
                    </div>
                    {c.decision_note && <div className="small" style={{ marginTop: 4 }}>Note: {c.decision_note}</div>}
                    {c.has_receipt ? (
                      <button className="link-btn small" style={{ marginTop: 6 }} onClick={() => setReceipt(c)}>
                        View receipt
                      </button>
                    ) : (
                      c.category !== 'mileage' && <div className="tiny muted" style={{ marginTop: 4 }}>No receipt</div>
                    )}
                  </div>
                  {c.status === 'pending' && isAdmin && !mine && (
                    <div className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setDeciding({ claim: c, approve: false })}>
                        Decline
                      </button>
                      <button className="btn btn-sm btn-navy" onClick={() => setDeciding({ claim: c, approve: true })}>
                        Approve
                      </button>
                    </div>
                  )}
                  {c.status === 'pending' && isAdmin && mine && <span className="tiny muted">Your own claim: another administrator decides it.</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {deciding && (
        <DecideDialog
          claim={deciding.claim}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            load();
          }}
        />
      )}
      {receipt && <ReceiptView claim={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
