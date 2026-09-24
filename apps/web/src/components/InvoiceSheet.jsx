import { fmtDate, fmtHours, fmtMoney } from '../lib/format.js';
import { COMPANY } from '@shared/domain.js';

/**
 * The invoice as a document, rather than as a screen.
 *
 * A client cannot be sent a CSV, so this is the thing that actually goes out:
 * one sheet, laid out to print, used by both the admin console and the client
 * portal so neither can drift from the other. Nothing here is internal - no
 * cost, no margin - because the same markup is what a client sees.
 */
export function InvoiceSheet({ invoice, lines, site }) {
  const address = [site?.address, [site?.city, site?.state].filter(Boolean).join(', '), site?.postal_code]
    .filter(Boolean);

  return (
    <div className="invoice-sheet">
      <header className="invoice-head">
        <div>
          <div className="invoice-company">{COMPANY.name}</div>
          <div className="invoice-meta">
            {COMPANY.addressLines.map((l) => (
              <div key={l}>{l}</div>
            ))}
            {COMPANY.phone && <div>{COMPANY.phone}</div>}
            {COMPANY.email && <div>{COMPANY.email}</div>}
            {COMPANY.website && <div>{COMPANY.website}</div>}
            <div>Licensed Florida security agency &middot; {COMPANY.licence}</div>
          </div>
        </div>
        <div className="invoice-title">
          <h1>Invoice</h1>
          <div className="invoice-number">{invoice.number}</div>
          {invoice.status === 'paid' && <div className="invoice-stamp">Paid</div>}
          {invoice.status === 'void' && <div className="invoice-stamp void">Void</div>}
        </div>
      </header>

      <section className="invoice-parties">
        <div>
          <h2>Billed to</h2>
          <div className="strong">{invoice.client_name || invoice.site_name}</div>
          <div className="invoice-meta">
            <div>{invoice.site_name}</div>
            {address.map((l) => (
              <div key={l}>{l}</div>
            ))}
            {invoice.contact_name && <div>Attn: {invoice.contact_name}</div>}
          </div>
        </div>
        <div>
          <h2>Details</h2>
          <dl className="invoice-details">
            <dt>Service period</dt>
            <dd>
              {fmtDate(invoice.period_start)} &ndash; {fmtDate(invoice.period_end)}
            </dd>
            {invoice.issued_at && (
              <>
                <dt>Issued</dt>
                <dd>{fmtDate(invoice.issued_at)}</dd>
              </>
            )}
            {invoice.due_on && (
              <>
                <dt>Due</dt>
                <dd>{fmtDate(invoice.due_on)}</dd>
              </>
            )}
            {invoice.paid_at && (
              <>
                <dt>Paid</dt>
                <dd>{fmtDate(invoice.paid_at)}</dd>
              </>
            )}
          </dl>
        </div>
      </section>

      <table className="invoice-lines">
        <thead>
          <tr>
            <th scope="col">Post</th>
            <th scope="col" className="num">Hours</th>
            <th scope="col" className="num">Rate</th>
            <th scope="col" className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <td>{l.description}</td>
              <td className="num">{fmtHours(l.hours)}</td>
              <td className="num">{fmtMoney(l.rate_cents)}/hr</td>
              <td className="num">{fmtMoney(l.amount_cents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="num">Subtotal</td>
            <td className="num">{fmtMoney(invoice.subtotal_cents)}</td>
          </tr>
          {invoice.tax_cents > 0 && (
            <tr>
              <td colSpan={3} className="num">Tax</td>
              <td className="num">{fmtMoney(invoice.tax_cents)}</td>
            </tr>
          )}
          <tr className="invoice-total">
            <td colSpan={3} className="num">Total due</td>
            <td className="num">{fmtMoney(invoice.total_cents)}</td>
          </tr>
        </tfoot>
      </table>

      {(invoice.notes || COMPANY.paymentTerms) && (
        <section className="invoice-notes">
          {invoice.notes && <p>{invoice.notes}</p>}
          {COMPANY.paymentTerms && <p>{COMPANY.paymentTerms}</p>}
        </section>
      )}

      <footer className="invoice-foot">
        Hours billed above are taken from officers&rsquo; own clock-in and clock-out records
        at {invoice.site_name}. The coverage record shows the same hours shift by shift.
      </footer>
    </div>
  );
}

/**
 * Print just the sheet.
 *
 * The document is rendered inside a scrolling dialog inside the app, and
 * neither merely hiding the rest nor making it invisible is enough: the
 * dialog's own max-height would clip a long invoice to one page, and hidden
 * boxes still take up space, which prints as blank pages.
 *
 * So the sheet is cloned to a container directly on <body>, and printing
 * shows that and nothing else. Cloning also guarantees the internal cost and
 * margin panel beside it cannot reach the page - it is not copied.
 */
export function printInvoice() {
  const source = document.querySelector('.invoice-sheet');
  if (!source) return;

  const holder = document.createElement('div');
  holder.className = 'print-portal';
  holder.appendChild(source.cloneNode(true));
  document.body.appendChild(holder);
  document.body.classList.add('printing-invoice');

  let cleaned = false;
  const done = () => {
    if (cleaned) return;
    cleaned = true;
    holder.remove();
    document.body.classList.remove('printing-invoice');
    window.removeEventListener('afterprint', done);
  };

  window.addEventListener('afterprint', done);
  window.print();
  // Not every browser fires afterprint; this is the belt to that braces.
  setTimeout(done, 1000);
}
