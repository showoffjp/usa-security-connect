/**
 * The four screens a client contact actually uses.
 *
 * They share a site filter and a date window, so they live together rather
 * than passing the same two pieces of state through a router.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../lib/api.js';
import { fmtDate, fmtDateTime, fmtMoney, fmtRange, fmtTime, fmtHours, toDateInput } from '../../lib/format.js';
import {
  Banner, Chip, Empty, Icon, LoadingPage, Modal, Progress, Segmented, Spinner, StatusChip, Stat,
} from '../../components/ui.jsx';
import { AuthedImage } from '../../components/AuthedImage.jsx';
import { InvoiceSheet, printInvoice } from '../../components/InvoiceSheet.jsx';

/* ------------------------------------------------------------ shared -- */

/** Load a portal endpoint, with the loading and error states spelled out. */
function usePortal(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await clientApi.get(path));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}

function Loaded({ loading, error, data, reload, children, label }) {
  if (loading && !data) return <LoadingPage label={label} />;
  if (error) {
    return (
      <Banner
        kind="danger"
        title="That did not load"
        action={
          <button className="btn btn-sm btn-ghost" onClick={reload}>
            Try again
          </button>
        }
      >
        {error}
      </Banner>
    );
  }
  return children;
}

/**
 * A client portal gets opened on a phone far more often than the staff console
 * does, and a wide table pushes the one column they care about - did somebody
 * turn up - behind a horizontal scroll. Narrow screens get cards instead.
 */
function useNarrow(maxWidth = 680) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${maxWidth}px)`).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [maxWidth]);
  return narrow;
}

/** A site picker, hidden entirely from a contact who only has one property. */
function SitePicker({ sites, value, onChange }) {
  if (sites.length < 2) return null;
  return (
    <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
      <label htmlFor="site">Property</label>
      <select id="site" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">All properties</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function DaysPicker({ value, onChange }) {
  return (
    <Segmented
      label="Time range"
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={[
        { value: '7', label: '7 days' },
        { value: '30', label: '30 days' },
        { value: '90', label: '90 days' },
      ]}
    />
  );
}

const query = (siteId, days) =>
  `?days=${days}${siteId ? `&siteId=${siteId}` : ''}`;

/**
 * How a shift should read to the client.
 *
 * A shift nobody has clocked into is only a failure once it is over. Calling a
 * future shift "not covered" in red would have clients ringing the office
 * about posts that are simply not due yet.
 */
function coverageStatus(shift, now = Date.now()) {
  if (shift.covered) {
    return shift.late ? { kind: 'warn', label: 'Late start' } : { kind: 'ok', label: 'Covered' };
  }
  if (new Date(shift.ends_at).getTime() < now) return { kind: 'danger', label: 'Not covered' };
  if (new Date(shift.starts_at).getTime() <= now) return { kind: 'warn', label: 'Awaiting clock-in' };
  return { kind: '', label: 'Scheduled' };
}

/* ---------------------------------------------------------- overview -- */

export function PortalOverview({ sites }) {
  const { data, error, loading, reload } = usePortal('/client/overview?days=7', []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coverage at a glance</h1>
          <p className="muted">
            {sites.length === 1 ? sites[0].name : `${sites.length} properties`} &middot; last 7 days
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reload} disabled={loading}>
          {loading ? <Spinner dark /> : <Icon name="refresh" size={16} />} Refresh
        </button>
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading your coverage">
        {data && (
          <div className="stack">
            <section className="card">
              <div className="card-head">
                <h2>On post right now</h2>
                <Chip kind={data.onPost.length ? 'ok' : ''} dot={data.onPost.length > 0}>
                  {data.onPost.length} on duty
                </Chip>
              </div>
              {data.onPost.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="shield" title="Nobody is clocked in">
                    This is normal outside your contracted hours.
                  </Empty>
                </div>
              ) : (
                <ul className="list">
                  {data.onPost.map((o) => (
                    <li key={o.id} className="list-item">
                      <div className="grow">
                        <div className="strong">{o.officer_name}</div>
                        <div className="small muted">
                          {o.post_name} &middot; {o.site_name}
                        </div>
                      </div>
                      <div className="nowrap small muted">since {fmtTime(o.clock_in_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="grid grid-4">
              <Stat
                label="Shifts covered"
                value={
                  data.summary.coveragePercent == null ? '--' : `${data.summary.coveragePercent}%`
                }
                foot={`${data.summary.shiftsCovered} of ${data.summary.shiftsScheduled} scheduled`}
                alert={data.summary.coveragePercent != null && data.summary.coveragePercent < 95}
              />
              <Stat label="Hours on site" value={data.summary.hoursOnSite} foot="last 7 days" />
              <Stat
                label="Patrols walked"
                value={data.summary.patrolRuns}
                foot={`${data.summary.checkpointsScanned} of ${data.summary.checkpointsTotal} checkpoints`}
              />
              <Stat
                label="Incidents"
                value={data.summary.incidents}
                foot={
                  data.summary.seriousIncidents > 0
                    ? `${data.summary.seriousIncidents} high or critical`
                    : 'none serious'
                }
                alert={data.summary.seriousIncidents > 0}
              />
            </div>

            {data.summary.supervisorVisits > 0 && (
              <Banner kind="info" title="Supervisor checks">
                A field supervisor visited your property {data.summary.supervisorVisits} time
                {data.summary.supervisorVisits === 1 ? '' : 's'} in the last 7 days.
              </Banner>
            )}

            <section className="card">
              <div className="card-head">
                <h2>Coming up</h2>
              </div>
              {data.upcoming.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="calendar" title="Nothing scheduled" />
                </div>
              ) : (
                <ul className="list">
                  {data.upcoming.map((s) => (
                    <li key={s.id} className="list-item">
                      <div className="grow">
                        <div className="strong">{s.post_name}</div>
                        <div className="small muted">
                          {s.site_name} &middot; {fmtDate(s.starts_at)}, {fmtRange(s.starts_at, s.ends_at)}
                        </div>
                      </div>
                      {s.officer_name ? (
                        <Chip>{s.officer_name}</Chip>
                      ) : (
                        // Honest about an unfilled post: the client will see
                        // it on the day anyway, and a surprise reads worse.
                        <Chip kind="warn">Being assigned</Chip>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Loaded>
    </div>
  );
}

/* ---------------------------------------------------------- coverage -- */

export function PortalCoverage({ sites }) {
  const [siteId, setSiteId] = useState(null);
  const [days, setDays] = useState(30);
  const narrow = useNarrow();
  const { data, error, loading, reload } = usePortal(`/client/coverage${query(siteId, days)}`, [siteId, days]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coverage record</h1>
          <p className="muted">Every scheduled shift, and who stood it.</p>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        <SitePicker sites={sites} value={siteId} onChange={setSiteId} />
        <DaysPicker value={days} onChange={setDays} />
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading coverage">
        {data &&
          (data.shifts.length === 0 ? (
            <div className="card card-pad">
              <Empty icon="calendar" title="No shifts in this period" />
            </div>
          ) : narrow ? (
            <div className="card">
              <ul className="list">
                {data.shifts.map((s) => {
                  const status = coverageStatus(s);
                  return (
                    <li key={s.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <div className="strong">{s.post_name}</div>
                        <div className="tiny muted">
                          {fmtDate(s.starts_at)} &middot; {fmtRange(s.starts_at, s.ends_at)}
                          {s.armed ? ' · armed' : ''}
                        </div>
                        <div className="small" style={{ marginTop: 3 }}>
                          {s.officer_name || <span className="muted">Unassigned</span>}
                          {s.clock_in_at && (
                            <span className="muted">
                              {' '}
                              &middot; {fmtTime(s.clock_in_at)}
                              {s.clock_out_at ? `-${fmtTime(s.clock_out_at)}` : ' onwards'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <Chip kind={status.kind}>{status.label}</Chip>
                        {s.hours_worked != null && (
                          <div className="tiny muted" style={{ marginTop: 3 }}>
                            {fmtHours(s.hours_worked)}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Post</th>
                    <th scope="col">Officer</th>
                    <th scope="col">Scheduled</th>
                    <th scope="col">On post</th>
                    <th scope="col">Hours</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shifts.map((s) => {
                    const status = coverageStatus(s);
                    return (
                      <tr key={s.id}>
                        <td className="nowrap">{fmtDate(s.starts_at)}</td>
                        <td>
                          <div className="strong">{s.post_name}</div>
                          <div className="tiny muted">
                            {s.site_name}
                            {s.armed ? ' · armed post' : ''}
                          </div>
                        </td>
                        <td>{s.officer_name || <span className="muted">Unassigned</span>}</td>
                        <td className="nowrap">{fmtRange(s.starts_at, s.ends_at)}</td>
                        <td className="nowrap">
                          {s.clock_in_at ? (
                            <>
                              {fmtTime(s.clock_in_at)}
                              {s.clock_out_at ? ` - ${fmtTime(s.clock_out_at)}` : ' - on post'}
                            </>
                          ) : (
                            <span className="muted">--</span>
                          )}
                        </td>
                        <td className="nowrap">{s.hours_worked == null ? '--' : fmtHours(s.hours_worked)}</td>
                        <td>
                          <Chip kind={status.kind}>{status.label}</Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </Loaded>
    </div>
  );
}

/* ----------------------------------------------------------- patrols -- */

function PatrolDialog({ runId, onClose }) {
  const { data, error, loading, reload } = usePortal(`/client/patrols/${runId}`, [runId]);

  return (
    <Modal title="Patrol record" onClose={onClose} wide>
      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading the patrol">
        {data && (
          <div className="stack">
            <dl className="kv">
              <dt>Patrol</dt>
              <dd>{data.run.tour_name}</dd>
              <dt>Officer</dt>
              <dd>{data.run.officer_name}</dd>
              <dt>Started</dt>
              <dd>{fmtDateTime(data.run.started_at)}</dd>
              <dt>Finished</dt>
              <dd>{data.run.completed_at ? fmtDateTime(data.run.completed_at) : 'Still in progress'}</dd>
            </dl>

            <ul className="timeline">
              {data.checkpoints.map((c) => (
                <li key={c.id} className="timeline-item">
                  <div className="row-between">
                    <div className="grow">
                      <div className="strong">{c.name}</div>
                      {c.instructions && <div className="tiny muted">{c.instructions}</div>}
                      {c.skip_reason && (
                        <div className="tiny" style={{ color: 'var(--warn-700, #92400e)' }}>
                          Skipped: {c.skip_reason}
                        </div>
                      )}
                    </div>
                    <div className="nowrap" style={{ textAlign: 'right' }}>
                      <StatusChip value={c.status} />
                      <div className="tiny muted">{c.scanned_at ? fmtTime(c.scanned_at) : '--'}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Loaded>
    </Modal>
  );
}

export function PortalPatrols({ sites }) {
  const [siteId, setSiteId] = useState(null);
  const [days, setDays] = useState(7);
  const [open, setOpen] = useState(null);
  const narrow = useNarrow();
  const { data, error, loading, reload } = usePortal(`/client/patrols${query(siteId, days)}`, [siteId, days]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Patrol proof</h1>
          <p className="muted">Each round walked, and every checkpoint reached.</p>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        <SitePicker sites={sites} value={siteId} onChange={setSiteId} />
        <DaysPicker value={days} onChange={setDays} />
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading patrols">
        {data &&
          (data.runs.length === 0 ? (
            <div className="card card-pad">
              <Empty icon="route" title="No patrols in this period">
                Patrol rounds walked at your property will be listed here.
              </Empty>
            </div>
          ) : narrow ? (
            <div className="card">
              <ul className="list">
                {data.runs.map((r) => (
                  <li key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      <div className="strong">{r.tour_name}</div>
                      <div className="tiny muted">
                        {fmtDateTime(r.started_at)} &middot; {r.officer_name}
                      </div>
                      <div className="small" style={{ marginTop: 4 }}>
                        {r.scanned} of {r.checkpoints} checkpoints
                        {r.skipped > 0 ? ` · ${r.skipped} skipped` : ''}
                      </div>
                      <Progress label="Checkpoints scanned on this round" value={r.scanned} max={r.checkpoints} ok={r.scanned === r.checkpoints} />
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <StatusChip value={r.status} />
                      <div>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(r.id)}>
                          View
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Round</th>
                    <th scope="col">Officer</th>
                    <th scope="col">Checkpoints</th>
                    <th scope="col">Status</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{fmtDateTime(r.started_at)}</td>
                      <td>
                        <div className="strong">{r.tour_name}</div>
                        <div className="tiny muted">{r.site_name}</div>
                      </td>
                      <td>{r.officer_name}</td>
                      <td style={{ minWidth: 140 }}>
                        <div className="small">
                          {r.scanned} of {r.checkpoints}
                          {r.skipped > 0 ? ` · ${r.skipped} skipped` : ''}
                        </div>
                        <Progress label="Checkpoints scanned on this round" value={r.scanned} max={r.checkpoints} ok={r.scanned === r.checkpoints} />
                      </td>
                      <td>
                        <StatusChip value={r.status} />
                      </td>
                      <td>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(r.id)}>
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Loaded>

      {open && <PatrolDialog runId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* --------------------------------------------------------- incidents -- */

function IncidentDialog({ id, onClose }) {
  const { data, error, loading, reload } = usePortal(`/client/incidents/${id}`, [id]);

  return (
    <Modal title="Incident report" onClose={onClose} wide>
      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading the report">
        {data && (
          <div className="stack">
            <div className="row" style={{ gap: 8 }}>
              <Chip kind="navy">{data.incident.ref_number}</Chip>
              <StatusChip value={data.incident.severity} />
              <StatusChip value={data.incident.status} />
              {data.incident.police_notified && <Chip kind="danger">Police notified</Chip>}
            </div>

            <dl className="kv">
              <dt>When</dt>
              <dd>{fmtDateTime(data.incident.occurred_at)}</dd>
              <dt>Where</dt>
              <dd>
                {data.incident.site_name}
                {data.incident.post_name ? ` · ${data.incident.post_name}` : ''}
                {data.incident.location_text ? ` · ${data.incident.location_text}` : ''}
              </dd>
              <dt>Reported by</dt>
              <dd>{data.incident.officer_name || '--'}</dd>
              {data.incident.category && (
                <>
                  <dt>Category</dt>
                  <dd>{data.incident.category}</dd>
                </>
              )}
              {data.incident.police_report_number && (
                <>
                  <dt>Police report</dt>
                  <dd className="mono">{data.incident.police_report_number}</dd>
                </>
              )}
            </dl>

            <div>
              <h3 className="small strong">What happened</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{data.incident.what_happened}</p>
            </div>

            {data.incident.resolution && (
              <div>
                <h3 className="small strong">How it was resolved</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{data.incident.resolution}</p>
              </div>
            )}

            {data.incident.people_notified && (
              <div>
                <h3 className="small strong">Who was notified</h3>
                <p>{data.incident.people_notified}</p>
              </div>
            )}

            {data.photos.length > 0 && (
              <div>
                <h3 className="small strong">Photographs</h3>
                <div className="photo-grid">
                  {data.photos.map((p) => (
                    <figure key={p.id}>
                      {/* Served through the API so the file stays behind auth. */}
                      <AuthedImage
                        client
                        src={`/client/incidents/${data.incident.id}/photos/${p.id}`}
                        alt={p.caption || p.original_name || 'Incident photograph'}
                      />
                      {p.caption && <figcaption className="tiny muted">{p.caption}</figcaption>}
                    </figure>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Loaded>
    </Modal>
  );
}

export function PortalIncidents({ sites }) {
  const [siteId, setSiteId] = useState(null);
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState(null);
  const narrow = useNarrow();
  const { data, error, loading, reload } = usePortal(`/client/incidents${query(siteId, days)}`, [siteId, days]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="muted">Everything reported at your property.</p>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        <SitePicker sites={sites} value={siteId} onChange={setSiteId} />
        <DaysPicker value={days} onChange={setDays} />
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading incidents">
        {data &&
          (data.incidents.length === 0 ? (
            <div className="card card-pad">
              <Empty icon="alert" title="Nothing reported in this period">
                A quiet property is a good result.
              </Empty>
            </div>
          ) : narrow ? (
            <div className="card">
              <ul className="list">
                {data.incidents.map((i) => (
                  <li key={i.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      <div className="row wrap" style={{ gap: 6 }}>
                        <span className="mono small strong">{i.ref_number}</span>
                        <StatusChip value={i.severity} />
                        <StatusChip value={i.status} />
                      </div>
                      <div className="tiny muted" style={{ marginTop: 3 }}>
                        {fmtDateTime(i.occurred_at)}
                        {i.location_text ? ` · ${i.location_text}` : ''}
                        {i.police_notified ? ' · police notified' : ''}
                      </div>
                      <button className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={() => setOpen(i.id)}>
                        Read {i.photo_count > 0 ? `(${i.photo_count} photo${i.photo_count === 1 ? '' : 's'})` : ''}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">When</th>
                    <th scope="col">Where</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Status</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.incidents.map((i) => (
                    <tr key={i.id}>
                      <td className="mono nowrap">{i.ref_number}</td>
                      <td className="nowrap">{fmtDateTime(i.occurred_at)}</td>
                      <td>
                        <div>{i.site_name}</div>
                        <div className="tiny muted">
                          {[i.post_name, i.location_text].filter(Boolean).join(' · ') || i.category}
                        </div>
                      </td>
                      <td>
                        <StatusChip value={i.severity} />
                      </td>
                      <td>
                        <StatusChip value={i.status} />
                        {i.police_notified && (
                          <div className="tiny muted" style={{ marginTop: 3 }}>
                            Police notified
                          </div>
                        )}
                      </td>
                      <td>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(i.id)}>
                          Read {i.photo_count > 0 ? `(${i.photo_count} photo${i.photo_count === 1 ? '' : 's'})` : ''}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Loaded>

      {open && <IncidentDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ---------------------------------------------------------- invoices -- */

function InvoiceDialog({ id, onClose }) {
  const { data, error, loading, reload } = usePortal(`/client/invoices/${id}`, [id]);

  return (
    <Modal
      title={data ? `Invoice ${data.invoice.number}` : 'Invoice'}
      onClose={onClose}
      wide
      footer={
        data && (
          <button className="btn btn-ghost" onClick={printInvoice}>
            <Icon name="clipboard" size={16} /> Print / save PDF
          </button>
        )
      }
    >
      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading the invoice">
        {data && (
          <div className="stack">
            {data.invoice.overdue_days > 0 && (
              <Banner kind="warn">This invoice is {data.invoice.overdue_days} days past its due date.</Banner>
            )}
            {/* The same document the account manager sends, so they cannot differ. */}
            <InvoiceSheet invoice={data.invoice} lines={data.lines} site={data.invoice} />
          </div>
        )}
      </Loaded>
    </Modal>
  );
}

export function PortalInvoices() {
  const [open, setOpen] = useState(null);
  const { data, error, loading, reload } = usePortal('/client/invoices', []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="muted">Billed from the hours on the coverage record.</p>
        </div>
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Loading invoices">
        {data && (
          <div className="stack">
            {data.outstandingCents > 0 && (
              <Banner kind="info" title="Outstanding">
                {fmtMoney(data.outstandingCents)} is currently outstanding across{' '}
                {data.invoices.filter((i) => i.status === 'sent').length} invoice
                {data.invoices.filter((i) => i.status === 'sent').length === 1 ? '' : 's'}.
              </Banner>
            )}

            {data.invoices.length === 0 ? (
              <div className="card card-pad">
                <Empty icon="clipboard" title="No invoices yet">
                  Invoices appear here once your account manager issues them.
                </Empty>
              </div>
            ) : (
              <div className="card">
                <ul className="list">
                  {data.invoices.map((i) => (
                    <li key={i.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <div className="row wrap" style={{ gap: 6 }}>
                          <span className="mono small strong">{i.number}</span>
                          <StatusChip value={i.status} />
                          {i.overdue_days > 0 && <Chip kind="danger">{i.overdue_days}d overdue</Chip>}
                        </div>
                        <div className="tiny muted" style={{ marginTop: 3 }}>
                          {i.site_name} &middot; {fmtDate(i.period_start)} to {fmtDate(i.period_end)}
                          {i.due_on ? ` · due ${fmtDate(i.due_on)}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="strong">{fmtMoney(i.total_cents)}</div>
                        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(i.id)}>
                          View
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Loaded>

      {open && <InvoiceDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* --------------------------------------------------------------- DAR -- */

export function PortalReport({ sites }) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? null);
  const [date, setDate] = useState(toDateInput(new Date()));
  const { data, error, loading, reload } = usePortal(
    `/client/dar?siteId=${siteId}&date=${date}`,
    [siteId, date]
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Daily activity report</h1>
          <p className="muted">The same document your account manager reviews.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>
          <Icon name="download" size={16} /> Print / save PDF
        </button>
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        {sites.length > 1 && (
          <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
            <label htmlFor="darSite">Property</label>
            <select id="darSite" value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ maxWidth: 200, marginBottom: 0 }}>
          <label htmlFor="darDate">Date</label>
          <input
            id="darDate"
            type="date"
            value={date}
            max={toDateInput(new Date())}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      <Loaded loading={loading} error={error} data={data} reload={reload} label="Building the report">
        {data && (
          <div className="stack">
            <div className="card card-pad">
              <h2 style={{ marginTop: 0 }}>{data.site.name}</h2>
              <p className="muted small" style={{ marginBottom: 0 }}>
                {[data.site.address, data.site.city, data.site.state].filter(Boolean).join(', ')}
                <br />
                {fmtDate(data.date)} &middot; {fmtHours(data.totalHours)} on site
              </p>
            </div>

            <section className="card">
              <div className="card-head">
                <h2>Who was on post</h2>
              </div>
              {data.coverage.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="clock" title="No officer clocked in on this date" />
                </div>
              ) : (
                <ul className="list">
                  {data.coverage.map((c, i) => (
                    <li key={i} className="list-item">
                      <div className="grow">
                        <div className="strong">{c.officer_name}</div>
                        <div className="small muted">{c.post_name}</div>
                      </div>
                      <div className="nowrap small">
                        {fmtTime(c.clock_in_at)} - {c.clock_out_at ? fmtTime(c.clock_out_at) : 'on post'}
                        {c.hours != null && <span className="muted"> · {fmtHours(c.hours)}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Patrols</h2>
              </div>
              {data.patrols.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="route" title="No patrols recorded on this date" />
                </div>
              ) : (
                <ul className="list">
                  {data.patrols.map((p) => (
                    <li key={p.id} className="list-item">
                      <div className="grow">
                        <div className="strong">{p.tour_name}</div>
                        <div className="small muted">
                          {fmtTime(p.started_at)}
                          {p.completed_at ? ` - ${fmtTime(p.completed_at)}` : ' - in progress'}
                        </div>
                      </div>
                      <div className="nowrap small">
                        {p.scanned} of {p.checkpoints} checkpoints
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Incidents</h2>
                <Chip kind={data.incidents.length ? 'warn' : 'ok'}>{data.incidents.length}</Chip>
              </div>
              {data.incidents.length === 0 ? (
                <div className="card-pad">
                  <Empty icon="alert" title="Nothing reported on this date" />
                </div>
              ) : (
                <ul className="list">
                  {data.incidents.map((i) => (
                    <li key={i.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <div className="row" style={{ gap: 8 }}>
                          <span className="mono small">{i.ref_number}</span>
                          <StatusChip value={i.severity} />
                        </div>
                        <div className="small" style={{ marginTop: 4 }}>
                          {i.what_happened}
                        </div>
                        {i.resolution && <div className="tiny muted">Resolved: {i.resolution}</div>}
                      </div>
                      <div className="nowrap small muted">{fmtTime(i.occurred_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.visits.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <h2>Supervisor visits</h2>
                </div>
                <ul className="list">
                  {data.visits.map((v, i) => (
                    <li key={i} className="list-item">
                      <div className="grow">
                        <div className="strong">{v.post_name || 'Site visit'}</div>
                        {v.notes && <div className="small muted">{v.notes}</div>}
                      </div>
                      <div className="nowrap small muted">{fmtTime(v.visited_at)}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Loaded>
    </div>
  );
}
