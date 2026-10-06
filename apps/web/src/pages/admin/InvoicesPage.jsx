import { useCallback, useEffect, useState } from 'react';
import { api, tokenStore } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime, fmtMoney, fmtHours, toDateInput } from '../../lib/format.js';
import { useSearchParams } from 'react-router-dom';
import {
  Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, Spinner, StatusChip, Stat, useToast,
} from '../../components/ui.jsx';
import { InvoiceSheet, printInvoice } from '../../components/InvoiceSheet.jsx';
import { missingCompanyDetails } from '@shared/domain.js';

/* ------------------------------------------------------ client questions -- */

function AnswerDialog({ query, onClose, onAnswered }) {
  const toast = useToast();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/invoices/queries/${query.id}/answer`, { answer });
      toast.success('Answer sent to the client.');
      onAnswered();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Answer about ${query.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || answer.trim().length < 5}>
            {busy ? 'Sending...' : 'Send answer'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          <strong>{query.asked_by || 'The client'}</strong> asked
          {query.line_description ? ` about "${query.line_description}"` : ''}:
          <p style={{ margin: '4px 0 0' }}>{query.question}</p>
        </div>
        <Field label="Your answer" required hint="The client reads this in the portal and by email.">
          <textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}

const WEEK_STATE = {
  approved: ['ok', 'Signed off'],
  waiting: ['warn', 'Waiting on the client'],
  changed: ['warn', 'Changed since signed off'],
  disputed: ['danger', 'Disputed'],
  not_ready: ['', 'Shift still running'],
  no_hours: ['', 'No hours'],
  in_progress: ['', 'Week not over'],
  no_contact: ['', 'No portal contact'],
};
const weekOf = (d) => fmtDate(`${d}T12:00:00`);

/** In the raise dialog: has the client signed off the weeks being billed? */
function SignoffNote({ signoff }) {
  const weeks = signoff.weeks.filter((w) => w.status !== 'no_hours');
  if (!weeks.length) return null;
  if (signoff.allApproved) {
    return (
      <Banner kind="ok" title="Signed off by the client">
        {weeks.length === 1 ? 'The client has signed off the hours for this week.' : `The client has signed off the hours for all ${weeks.length} weeks.`}
      </Banner>
    );
  }
  return (
    <Banner kind="warn" title="Not every week is signed off by the client">
      <ul className="tight-list">
        {weeks.map((w) => (
          <li key={w.week_of}>
            Week of {weekOf(w.week_of)}: {(WEEK_STATE[w.status] || ['', w.status])[1].toLowerCase()}
            {w.note ? ` - "${w.note}"` : ''}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/** Reply to a client who disputed a week's hours. */
function ReplyDialog({ site, week, onClose, onReplied }) {
  const toast = useToast();
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/signoffs/${week.signoff.id}/reply`, { response });
      toast.success('Reply sent to the client.');
      onReplied();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${site.name}: week of ${weekOf(week.week_of)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || response.trim().length < 5}>
            {busy ? 'Sending...' : 'Send reply'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          <strong>{week.signoff.client_name || 'The client'}</strong> disputed {fmtHours(week.hours)}:
          <p style={{ margin: '4px 0 0' }}>{week.signoff.note}</p>
        </div>
        <Field label="Your reply" required hint="The client reads this in the portal and by email. Once the hours look right to them, they sign the week off.">
          <textarea rows={4} value={response} onChange={(e) => setResponse(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Every property's recent weeks and whether the client has signed off the
 * hours, with disputes to answer. These are the hours the invoices bill.
 */
function SignoffTab() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [replying, setReplying] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/signoffs?weeks=4'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (error) return <Banner kind="danger">{error}</Banner>;
  if (!data) return <LoadingPage label="Loading sign-offs" />;
  const weekKeys = [...new Set(data.sites.flatMap((s) => s.weeks.map((w) => w.week_of)))].sort().reverse();
  const disputes = data.sites.flatMap((site) => site.weeks.filter((w) => w.status === 'disputed').map((w) => ({ site, week: w })));

  return (
    <div className="stack">
      <div className="grid grid-4">
        <Stat label="Signed off" value={data.counts.approved} foot={`weeks, last ${data.weeks}`} />
        <Stat label="Waiting on clients" value={data.counts.waiting} foot="weeks not answered yet" />
        <Stat label="Disputed" value={data.counts.disputed} foot="clients query the hours" alert={data.counts.disputed > 0} />
        <Stat label="Changed since" value={data.counts.changed} foot="hours corrected after sign-off" alert={data.counts.changed > 0} />
      </div>

      {disputes.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Disputed hours</h3></div>
          <ul className="list">
            {disputes.map(({ site, week }) => (
              <li key={`${site.id}:${week.week_of}`} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <strong>{site.name}</strong>
                    <span className="small muted">week of {weekOf(week.week_of)} &middot; {fmtHours(week.hours)}</span>
                    {week.signoff.response ? <Chip kind="ok">Replied</Chip> : <Chip kind="danger">Waiting for our reply</Chip>}
                  </div>
                  <div className="small" style={{ marginTop: 4 }}>{week.signoff.note}</div>
                  <div className="tiny muted">{week.signoff.client_name || 'Client'}, {fmtDateTime(week.signoff.decided_at)}</div>
                  {week.signoff.response && (
                    <div className="invoice-answer small">
                      <strong>Our reply:</strong> {week.signoff.response}
                      <div className="tiny muted">{week.signoff.responded_by_name}, {fmtDateTime(week.signoff.responded_at)}</div>
                    </div>
                  )}
                </div>
                {isAdmin && !week.signoff.response && (
                  <button className="btn btn-sm btn-primary" onClick={() => setReplying({ site, week })}
                    aria-label={`Reply to ${site.name} about the week of ${weekOf(week.week_of)}`}>
                    Reply
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Weeks by property</h3>
          <span className="small muted">The hours each client has signed off, week by week</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Property</th>
                {weekKeys.map((k) => <th key={k} scope="col">Week of {weekOf(k)}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.sites.map((site) => (
                <tr key={site.id}>
                  <td>
                    <div className="strong">{site.name}</div>
                    <div className="tiny muted">{site.contacts ? `${site.contacts} portal contact${site.contacts === 1 ? '' : 's'}` : 'No portal contact'}</div>
                  </td>
                  {weekKeys.map((k) => {
                    const w = site.weeks.find((x) => x.week_of === k);
                    if (!w) return <td key={k} className="muted">--</td>;
                    const [kind, label] = WEEK_STATE[w.status] || ['', w.status];
                    return (
                      <td key={k}>
                        <div className="small">{fmtHours(w.hours)}</div>
                        <Chip kind={kind}>{label}</Chip>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {replying && (
        <ReplyDialog site={replying.site} week={replying.week} onClose={() => setReplying(null)}
          onReplied={() => { setReplying(null); load(); }} />
      )}
    </div>
  );
}

/** Clients' questions, with the answer or a button to give one. */
function QueryList({ queries, onChanged, showInvoice = false, onOpenInvoice }) {
  const [answering, setAnswering] = useState(null);
  if (!queries.length) return <Empty icon="message" title="No questions" />;
  return (
    <>
      <ul className="list">
        {queries.map((q) => (
          <li key={q.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                {showInvoice && (
                  <button className="btn btn-sm btn-ghost mono" onClick={() => onOpenInvoice(q.invoice_id)}>
                    {q.number}
                  </button>
                )}
                {q.status === 'open' ? <Chip kind="warn">Waiting</Chip> : <Chip kind="ok">Answered</Chip>}
                {q.line_description && <span className="tiny muted">{q.line_description}</span>}
              </div>
              <div className="small" style={{ marginTop: 4 }}>{q.question}</div>
              <div className="tiny muted">
                {q.asked_by || 'Client'}
                {q.asked_by_email ? ` (${q.asked_by_email})` : ''} · {showInvoice ? `${q.site_name} · ` : ''}
                {fmtDateTime(q.created_at)}
              </div>
              {q.answer && (
                <div className="invoice-answer small">
                  {q.answer}
                  <div className="tiny muted">
                    {q.answered_by_name}, {fmtDateTime(q.answered_at)}
                  </div>
                </div>
              )}
            </div>
            {q.status === 'open' && (
              <button className="btn btn-sm btn-primary" onClick={() => setAnswering(q)}>
                Answer
              </button>
            )}
          </li>
        ))}
      </ul>
      {answering && (
        <AnswerDialog
          query={answering}
          onClose={() => setAnswering(null)}
          onAnswered={() => {
            setAnswering(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function QuestionsTab({ onOpenInvoice }) {
  const toast = useToast();
  const [show, setShow] = useState('open');
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/invoices/queries?status=${show}`));
    } catch (err) {
      toast.error(err.message);
      setData({ queries: [], open: 0 });
    }
  }, [show, toast]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="stack">
      <Segmented
        label="Which questions"
        value={show}
        onChange={setShow}
        options={[
          { value: 'open', label: `Waiting${data ? ` (${data.open})` : ''}` },
          { value: 'answered', label: 'Answered' },
          { value: 'all', label: 'All' },
        ]}
      />
      <div className="card">
        {!data ? <LoadingPage label="Loading questions" /> : <QueryList queries={data.queries} onChanged={load} showInvoice onOpenInvoice={onOpenInvoice} />}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- raise dialog -- */

/**
 * Preview first, always.
 *
 * An invoice is built from hours already recorded, so the only judgement
 * calls are the period and the rate - both of which are much easier to get
 * right when you can see what they produce before committing a number.
 */
function RaiseDialog({ sites, onClose, onCreated }) {
  const toast = useToast();

  // Default to the week just gone: the most common billing run.
  const [siteId, setSiteId] = useState(sites[0]?.id ?? null);
  const [start, setStart] = useState(() => toDateInput(new Date(Date.now() - 7 * 86400000)));
  const [end, setEnd] = useState(() => toDateInput(new Date(Date.now() - 86400000)));
  const [taxPercent, setTaxPercent] = useState(0);
  const [dueDays, setDueDays] = useState(30);
  const [notes, setNotes] = useState('');

  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!siteId || !start || !end) return;
    let cancelled = false;
    setLoading(true);
    api
      .get(`/invoices/preview?siteId=${siteId}&periodStart=${start}&periodEnd=${end}&taxPercent=${taxPercent}`)
      .then((p) => !cancelled && (setPreview(p), setError('')))
      .catch((err) => !cancelled && (setPreview(null), setError(err.message)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [siteId, start, end, taxPercent]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await api.post('/invoices', {
        siteId: Number(siteId),
        periodStart: start,
        periodEnd: end,
        taxPercent: Number(taxPercent),
        dueDays: Number(dueDays),
        notes: notes.trim() || undefined,
      });
      toast.success(`${res.invoice.number} raised as a draft.`);
      onCreated(res.invoice.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const hasLines = (preview?.lines?.length ?? 0) > 0;

  return (
    <Modal
      title="Raise an invoice"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy || !hasLines}>
            {busy ? <Spinner /> : null} Raise draft
            {preview ? ` for ${fmtMoney(preview.totals.totalCents)}` : ''}
          </button>
        </>
      }
    >
      <div className="stack">
        {error && <Banner kind="danger">{error}</Banner>}

        <div className="grid grid-2">
          <Field label="Site" required>
            <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payment terms">
            <select value={dueDays} onChange={(e) => setDueDays(Number(e.target.value))}>
              <option value={7}>Net 7</option>
              <option value={14}>Net 14</option>
              <option value={30}>Net 30</option>
              <option value={45}>Net 45</option>
              <option value={60}>Net 60</option>
            </select>
          </Field>
          <Field label="Period start" required>
            <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Period end" required>
            <input type="date" value={end} min={start} max={toDateInput(new Date())} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Tax %" hint="Leave at 0 where guarding is not taxable.">
            <input
              type="number"
              min={0}
              max={30}
              step={0.1}
              value={taxPercent}
              onChange={(e) => setTaxPercent(e.target.value === '' ? 0 : Number(e.target.value))}
            />
          </Field>
        </div>

        {preview?.overlapping?.length > 0 && (
          <Banner kind="warn" title="These hours may already be billed">
            {preview.overlapping.map((o) => `${o.number} covers ${o.period_start} to ${o.period_end}`).join('; ')}.
          </Banner>
        )}

        {preview?.signoff && preview.lines?.length > 0 && <SignoffNote signoff={preview.signoff} />}

        {preview?.unpriced?.length > 0 && (
          <Banner kind="danger" title="Some hours have no bill rate">
            {preview.unpriced.map((u) => `${u.post_name} (${fmtHours(u.minutes / 60)})`).join(', ')}. Set a rate on
            the post, then reopen this.
          </Banner>
        )}

        {loading && !preview ? (
          <div className="center" style={{ padding: 24 }}>
            <Spinner dark />
          </div>
        ) : !hasLines ? (
          <Empty icon="clock" title="No billable hours in this period">
            Nothing was clocked at this site between those dates.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Post</th>
                  <th scope="col">Hours</th>
                  <th scope="col">Rate</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.description}</td>
                    <td className="nowrap">{fmtHours(l.hours)}</td>
                    <td className="nowrap">{fmtMoney(l.rate_cents)}/hr</td>
                    <td className="nowrap strong">{fmtMoney(l.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="muted">
                    Subtotal
                  </td>
                  <td className="nowrap">{fmtMoney(preview.totals.subtotalCents)}</td>
                </tr>
                {preview.totals.taxCents > 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      Tax
                    </td>
                    <td className="nowrap">{fmtMoney(preview.totals.taxCents)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={3} className="strong">
                    Total
                  </td>
                  <td className="nowrap strong">{fmtMoney(preview.totals.totalCents)}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="tiny muted">
                    Direct labour cost, for margin
                  </td>
                  <td className="tiny muted nowrap">
                    {fmtMoney(preview.totals.costCents)} &middot; {preview.totals.marginPercent}% margin
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <Field label="Notes" hint="Appears on the invoice the client sees.">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- detail dialog -- */

function InvoiceDialog({ id, onClose, onChanged }) {
  const toast = useToast();
  // Raising, issuing and voiding are administrator work. A supervisor reads.
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/invoices/${id}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (status) => {
    if (status === 'void' && !window.confirm('Void this invoice? It stays in the ledger but is no longer owed.')) {
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/invoices/${id}`, { status });
      toast.success(`Invoice marked ${status}.`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this draft? It has not been issued, so nothing is lost.')) return;
    try {
      await api.del(`/invoices/${id}`);
      toast.success('Draft deleted.');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err.message);
    }
  };

  /* A CSV download needs the bearer token, so it cannot be a plain link. */
  const downloadCsv = async () => {
    try {
      const res = await fetch(`/api/invoices/${id}/csv`, {
        headers: { Authorization: `Bearer ${tokenStore.get()}` },
      });
      if (!res.ok) throw new Error('The export failed.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.invoice.number}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const invoice = data?.invoice;
  const missing = missingCompanyDetails();
  const margin = invoice && invoice.subtotal_cents > 0
    ? Math.round(((invoice.subtotal_cents - invoice.cost_cents) / invoice.subtotal_cents) * 1000) / 10
    : null;

  return (
    <Modal
      title={invoice ? `Invoice ${invoice.number}` : 'Invoice'}
      onClose={onClose}
      wide
      footer={
        invoice && (
          <>
            <button className="btn btn-ghost" onClick={printInvoice}>
              <Icon name="clipboard" size={16} /> Print / PDF
            </button>
            <button className="btn btn-ghost" onClick={downloadCsv}>
              <Icon name="download" size={16} /> CSV
            </button>
            {isAdmin && invoice.status === 'draft' && (
              <>
                <button className="btn btn-danger" onClick={remove}>
                  Delete
                </button>
                <button className="btn btn-ghost" onClick={() => setStatus('void')} disabled={busy}>
                  Void
                </button>
                <button className="btn btn-primary" onClick={() => setStatus('sent')} disabled={busy}>
                  Mark sent
                </button>
              </>
            )}
            {isAdmin && invoice.status === 'sent' && (
              <>
                <button className="btn btn-ghost" onClick={() => setStatus('void')} disabled={busy}>
                  Void
                </button>
                <button className="btn btn-primary" onClick={() => setStatus('paid')} disabled={busy}>
                  Mark paid
                </button>
              </>
            )}
          </>
        )
      }
    >
      {error && <Banner kind="danger">{error}</Banner>}
      {!invoice ? (
        <div className="center" style={{ padding: 30 }}>
          <Spinner dark />
        </div>
      ) : (
        <div className="stack">
          <div className="row wrap" style={{ gap: 8 }}>
            <StatusChip value={invoice.status} />
            {invoice.overdue_days > 0 && <Chip kind="danger">{invoice.overdue_days} days overdue</Chip>}
          </div>

          {missing.length > 0 && (
            <Banner kind="warn" title="This invoice is missing your company details">
              No {missing.join(', ')} is set, so those lines are left off the printed
              invoice. Fill them in at <code>COMPANY</code> in{' '}
              <code>packages/shared/src/domain.js</code> before sending one to a client.
            </Banner>
          )}

          {/* The document itself, so what is reviewed is what gets sent. */}
          <InvoiceSheet invoice={invoice} lines={data.lines} site={invoice} />

          {data.queries?.length > 0 && (
            <section aria-labelledby="invoice-queries-title">
              <h3 id="invoice-queries-title" className="small strong" style={{ margin: '0 0 6px' }}>
                Client questions
              </h3>
              <QueryList
                queries={data.queries}
                onChanged={() => {
                  load();
                  onChanged();
                }}
              />
            </section>
          )}

          <Banner kind="info" title="Internal only">
            Direct labour cost {fmtMoney(invoice.cost_cents)}, margin {fmtMoney(invoice.subtotal_cents - invoice.cost_cents)}
            {margin != null ? ` (${margin}%)` : ''}. This is officers' base hourly pay for the period and does not
            include the overtime premium, which belongs to a week rather than to one site. It is never shown in the
            client portal.
          </Banner>
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------- page -- */

export default function InvoicesPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [sites, setSites] = useState([]);
  const [status, setStatus] = useState('all');
  const [error, setError] = useState('');
  const [raising, setRaising] = useState(false);
  const [open, setOpen] = useState(null);
  const [params, setParams] = useSearchParams();
  const tab = ['questions', 'signoff'].includes(params.get('tab')) ? params.get('tab') : 'invoices';

  const load = useCallback(async () => {
    try {
      const [inv, s] = await Promise.all([
        api.get(`/invoices${status === 'all' ? '' : `?status=${status}`}`),
        api.get('/admin/sites'),
      ]);
      setData(inv);
      setSites(s.sites);
      setError('');
    } catch (err) {
      setError(err.message);
      setData({ invoices: [], summary: {} });
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <LoadingPage label="Loading invoices" />;

  const { summary } = data;
  const openQueries = data.invoices.reduce((n, i) => n + (i.open_queries || 0), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="muted">Raised from hours already on the clock, at the bill rate that applied.</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setRaising(true)} disabled={sites.length === 0}>
            <Icon name="plus" size={16} /> Raise invoice
          </button>
        )}
      </div>

      {error && <Banner kind="danger">{error}</Banner>}

      <div style={{ marginBottom: 16 }}>
        <Segmented
          label="Invoices view"
          value={tab}
          onChange={(v) => setParams(v === 'invoices' ? {} : { tab: v }, { replace: true })}
          options={[
            { value: 'invoices', label: 'Invoices' },
            { value: 'questions', label: `Client questions${openQueries ? ` (${openQueries})` : ''}` },
            { value: 'signoff', label: 'Client sign-off' },
          ]}
        />
      </div>

      {tab === 'signoff' ? (
        <SignoffTab />
      ) : tab === 'questions' ? (
        <QuestionsTab onOpenInvoice={setOpen} />
      ) : (
      <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Outstanding" value={fmtMoney(summary.outstanding_cents)} foot="sent, not yet paid" />
        <Stat label="Drafts" value={fmtMoney(summary.draft_cents)} foot="not issued" />
        <Stat label="Collected" value={fmtMoney(summary.paid_cents)} foot="paid to date" />
        <Stat
          label="Margin"
          value={summary.margin_percent == null ? '--' : `${summary.margin_percent}%`}
          foot={`${fmtMoney(summary.margin_cents)} on ${fmtMoney(summary.billed_cents)} billed`}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Segmented
          label="Invoice status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'draft', label: 'Drafts' },
            { value: 'sent', label: 'Outstanding' },
            { value: 'paid', label: 'Paid' },
            { value: 'void', label: 'Void' },
          ]}
        />
      </div>

      {data.invoices.length === 0 ? (
        <div className="card card-pad">
          <Empty
            icon="clipboard"
            title="No invoices here"
            action={
              status === 'all' && isAdmin ? (
                <button className="btn btn-primary" onClick={() => setRaising(true)}>
                  Raise the first one
                </button>
              ) : null
            }
          >
            {status === 'all'
              ? 'Pick a site and a period; the hours are already recorded.'
              : 'Nothing matches this filter.'}
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Client</th>
                <th scope="col">Period</th>
                <th scope="col">Total</th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="mono nowrap">{i.number}</td>
                  <td>
                    <div className="strong">{i.client_name || i.site_name}</div>
                    <div className="tiny muted">{i.site_name}</div>
                  </td>
                  <td className="nowrap small">
                    {fmtDate(i.period_start)} - {fmtDate(i.period_end)}
                  </td>
                  <td className="nowrap strong">{fmtMoney(i.total_cents)}</td>
                  <td>
                    <StatusChip value={i.status} />
                  </td>
                  <td className="nowrap small">
                    {i.due_on ? fmtDate(i.due_on) : '--'}
                    {i.overdue_days > 0 && (
                      <div>
                        <Chip kind="danger">{i.overdue_days}d overdue</Chip>
                      </div>
                    )}
                    {i.open_queries > 0 && (
                      <div>
                        <Chip kind="warn">Question waiting</Chip>
                      </div>
                    )}
                  </td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => setOpen(i.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      </>
      )}

      {raising && (
        <RaiseDialog
          sites={sites}
          onClose={() => setRaising(false)}
          onCreated={(id) => {
            setRaising(false);
            load();
            setOpen(id);
          }}
        />
      )}

      {open && <InvoiceDialog id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
