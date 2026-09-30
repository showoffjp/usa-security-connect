import { fmtDate, fmtTime } from '../lib/format.js';

// A document outlives the week it was printed in, so its dates carry the year.
const when = (d) => `${fmtDate(d)}, ${fmtTime(d)}`;
import { COMPANY } from '@shared/domain.js';
import { printSheet } from './InvoiceSheet.jsx';

const SEVERITY = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const STATUS = { submitted: 'Submitted', under_review: 'Under review', closed: 'Closed' };

/**
 * An incident report as a document: what an insurer, the police or a
 * property manager's file wants. Built from what the caller already shows,
 * so the client's copy carries only what the portal shows them, and the
 * office's copy leaves out review notes and cost recovery - it is the one
 * that gets handed over.
 */
/** The sheet, kept off screen until it is printed. */
export function PrintableIncident(props) {
  return (
    <div className="print-source" hidden>
      <IncidentSheet {...props} />
    </div>
  );
}

export function IncidentSheet({ incident: i, actions = [], photos = 0, showOwners = false }) {
  const officer = i.reported_by || i.officer_name;
  // Internal follow-ups (an HR review, officer coaching) stay off the page either way.
  const shared = actions.filter((a) => a.client_visible !== false);
  return (
    <div className="invoice-sheet incident-sheet">
      <header className="invoice-head">
        <div>
          <div className="invoice-company">{COMPANY.name}</div>
          <div className="invoice-meta">
            <div>Licensed Florida security agency &middot; {COMPANY.licence}</div>
            {COMPANY.website && <div>{COMPANY.website}</div>}
          </div>
        </div>
        <div className="invoice-title">
          <h1>Incident report</h1>
          <div className="invoice-number">{i.ref_number}</div>
        </div>
      </header>

      <dl className="invoice-details incident-facts">
        <dt>Occurred</dt>
        <dd>{when(i.occurred_at)}</dd>
        <dt>Site</dt>
        <dd>
          {i.site_name || '--'}
          {i.post_name ? ` / ${i.post_name}` : ''}
        </dd>
        {i.location_text && (
          <>
            <dt>Location</dt>
            <dd>{i.location_text}</dd>
          </>
        )}
        <dt>Type</dt>
        <dd>{i.category || '--'}</dd>
        <dt>Severity</dt>
        <dd>{SEVERITY[i.severity] || i.severity}</dd>
        <dt>Status</dt>
        <dd>{STATUS[i.status] || i.status}</dd>
        {officer && (
          <>
            <dt>Reported by</dt>
            <dd>{officer}</dd>
          </>
        )}
        <dt>Police</dt>
        <dd>
          {i.police_notified ? 'Notified' : 'Not notified'}
          {i.police_report_number ? `, report ${i.police_report_number}` : ''}
        </dd>
      </dl>

      <section className="incident-section">
        <h2>What happened</h2>
        <p>{i.what_happened}</p>
      </section>
      {i.resolution && (
        <section className="incident-section">
          <h2>How it was resolved</h2>
          <p>{i.resolution}</p>
        </section>
      )}
      {i.other_details && (
        <section className="incident-section">
          <h2>Other details</h2>
          <p>{i.other_details}</p>
        </section>
      )}
      {i.people_involved && (
        <section className="incident-section">
          <h2>People involved</h2>
          <p>{i.people_involved}</p>
        </section>
      )}
      {i.people_notified && (
        <section className="incident-section">
          <h2>Who was notified</h2>
          <p>{i.people_notified}</p>
        </section>
      )}

      {shared.length > 0 && (
        <section className="incident-section">
          <h2>Follow-up</h2>
          <table className="invoice-lines">
            <thead>
              <tr>
                <th>Action</th>
                {showOwners && <th>Owner</th>}
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shared.map((a) => (
                <tr key={a.id}>
                  <td>{a.title}</td>
                  {showOwners && <td>{a.owner_name || '--'}</td>}
                  <td className="nowrap">{a.due_on ? fmtDate(a.due_on) : '--'}</td>
                  <td>{a.status === 'done' ? `Done${a.done_at ? ` ${fmtDate(a.done_at)}` : ''}` : 'In hand'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="incident-foot">
        {photos > 0 ? `${photos} photograph${photos === 1 ? '' : 's'} on file with this report. ` : ''}
        Printed {when(new Date())}.
      </footer>
    </div>
  );
}

export const printIncident = () => printSheet('.incident-sheet');
