import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDateShort, fmtMoney, toDateInput } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, Modal, Stat, useToast } from '../../components/ui.jsx';
import { ReceiptView } from '../../components/ReceiptView.jsx';
import { expenseAmountCents } from '@shared/domain.js';

export const EXPENSE_CHIP = { pending: 'warn', approved: 'info', paid: 'ok', declined: 'danger', withdrawn: '' };
const cents = (dollars) => fmtMoney(Math.round((dollars || 0) * 100));
/** "2026-09-14 to 2026-09-20" as "Sep 14 to Sep 20". */
export const fmtPaidIn = (s) => (s ? s.split(' to ').map(fmtDateShort).join(' to ') : '');

/** Money spent on the job, claimed back and paid with the payroll. */
export default function MyExpenses() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [receipt, setReceipt] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/expenses/mine'));
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const withdraw = async (c) => {
    if (!window.confirm(`Withdraw the ${c.category_label.toLowerCase()} claim for ${cents(c.amount)}?`)) return;
    try {
      await api.post(`/expenses/${c.id}/withdraw`);
      toast.success('Claim withdrawn.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!data) return null;
  const { claims, summary } = data;

  return (
    <div className="card" id="expenses">
      <div className="card-head wrap">
        <h3>My expenses</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setClaiming(true)}>
          <Icon name="plus" size={16} /> Claim an expense
        </button>
      </div>
      <div className="card-body stack">
        <div className="grid grid-3">
          <Stat label="Waiting for a decision" value={cents(summary.pending)} />
          <Stat label="Approved" value={cents(summary.approved)} foot="Paid with the next payroll" />
          <Stat label="Paid back" value={cents(summary.paid)} />
        </div>
        {claims.length === 0 ? (
          <Empty icon="dollar" title="No claims yet">
            Parking, tolls, supplies or miles in your own car on the job: claim them here and they are paid with your wages.
          </Empty>
        ) : (
          <div className="list">
            {claims.slice(0, 12).map((c) => (
              <div key={c.id} className="list-item expense-item" style={{ cursor: 'default' }}>
                <div className="lead-icon">
                  <Icon name={c.category === 'mileage' ? 'car' : 'dollar'} size={17} />
                </div>
                <div className="grow">
                  <div className="small strong">
                    {c.category_label} · {cents(c.amount)}
                    {c.miles != null && <span className="muted"> ({c.miles} mi)</span>}
                  </div>
                  <div className="tiny muted">
                    {fmtDate(c.incurred_on)}
                    {c.site_name ? ` · ${c.site_name}` : ''} · {c.description}
                  </div>
                  {c.status === 'declined' && c.decision_note && <div className="tiny" style={{ color: 'var(--danger)' }}>Declined: {c.decision_note}</div>}
                  {c.status === 'approved' && <div className="tiny muted">Paid with the next payroll.{c.decision_note ? ` Note: ${c.decision_note}` : ''}</div>}
                  {c.paid_in && <div className="tiny muted">Paid with the payroll for {fmtPaidIn(c.paid_in)}</div>}
                  {(c.has_receipt || c.status === 'pending') && (
                    <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                      {c.has_receipt && (
                        <button className="link-btn tiny" onClick={() => setReceipt(c)}>
                          View receipt
                        </button>
                      )}
                      {c.status === 'pending' && (
                        <button className="link-btn tiny" onClick={() => withdraw(c)}>
                          Withdraw
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="list-trailing">
                  <Chip kind={EXPENSE_CHIP[c.status]}>{c.status_label}</Chip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {claiming && (
        <ClaimExpense
          rules={data.rules}
          categories={data.categories}
          onClose={() => setClaiming(false)}
          onDone={() => {
            setClaiming(false);
            load();
          }}
        />
      )}
      {receipt && <ReceiptView claim={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

export function ClaimExpense({ rules, categories, onClose, onDone }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [sites, setSites] = useState([]);
  const [category, setCategory] = useState('parking');
  const [incurredOn, setIncurredOn] = useState(toDateInput(new Date()));
  const [amount, setAmount] = useState('');
  const [miles, setMiles] = useState('');
  const [siteId, setSiteId] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/reference').then((r) => setSites(r.sites), () => {});
  }, []);

  const mileage = category === 'mileage';
  const total = expenseAmountCents({ category, miles: Number(miles) || 0, amountCents: Math.round((Number(amount) || 0) * 100) });
  const needsReceipt = !mileage && total > rules.receiptRequiredCents;
  const earliest = toDateInput(new Date(Date.now() - rules.windowDays * 86400000));

  const save = async () => {
    setBusy(true);
    setErrors({});
    const form = new FormData();
    form.set('category', category);
    form.set('incurredOn', incurredOn);
    if (mileage) form.set('miles', miles);
    else form.set('amount', amount);
    if (siteId) form.set('siteId', siteId);
    form.set('description', description.trim());
    if (file) form.set('receipt', file);
    try {
      await api.upload('/expenses', form);
      toast.success('Claim sent. An administrator will look at it.');
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Claim an expense"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || total <= 0 || description.trim().length < 5 || (needsReceipt && !file)}>
            {busy ? 'Sending...' : `Claim ${fmtMoney(total)}`}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="What for" required error={errors.category}>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When" required error={errors.incurredOn} hint={`Within the last ${rules.windowDays} days.`}>
            <input type="date" value={incurredOn} min={earliest} max={toDateInput(new Date())} onChange={(e) => setIncurredOn(e.target.value)} />
          </Field>
        </div>
        {mileage ? (
          <Field label="Miles driven" required error={errors.miles}
            hint={`Paid at ${rules.mileageRateCents}¢ a mile${Number(miles) > 0 ? `: ${fmtMoney(total)}` : ''}. No receipt needed.`}>
            <input type="number" inputMode="decimal" min="0.1" max="1000" step="0.1" value={miles} onChange={(e) => setMiles(e.target.value)} />
          </Field>
        ) : (
          <Field label="Amount ($)" required error={errors.amount}
            hint={`A receipt is needed over $${rules.receiptRequiredCents / 100}; up to $${rules.maxCents / 100} a claim.`}>
            <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        <Field label="Site" error={errors.siteId} hint="Optional.">
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">Not for one site</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What it was for" required error={errors.description}>
          <textarea rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={mileage ? 'From where to where, and why.' : 'What you bought or paid for, and why.'} />
        </Field>
        {!mileage && (
          <Field label="Receipt" required={needsReceipt} error={errors.receipt} hint="A photo or a PDF.">
            <div className="row wrap" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
                <Icon name="camera" size={16} /> {file ? 'Replace' : 'Add the receipt'}
              </button>
              {file && <span className="small muted">{file.name}</span>}
            </div>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" hidden aria-label="Receipt file"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                e.target.value = '';
              }} />
          </Field>
        )}
        {needsReceipt && !file && (
          <Banner kind="info">
            <span className="small">Anything over ${rules.receiptRequiredCents / 100} needs a photo of the receipt.</span>
          </Banner>
        )}
      </div>
    </Modal>
  );
}
