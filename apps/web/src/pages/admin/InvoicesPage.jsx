import { useCallback, useEffect, useState } from 'react';
import { api, tokenStore } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtMoney, fmtHours, toDateInput } from '../../lib/format.js';
import {
  Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, Spinner, StatusChip, Stat, useToast,
} from '../../components/ui.jsx';
import { InvoiceSheet, printInvoice } from '../../components/InvoiceSheet.jsx';
import { missingCompanyDetails } from '@shared/domain.js';

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
            <table>
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
          <table>
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
