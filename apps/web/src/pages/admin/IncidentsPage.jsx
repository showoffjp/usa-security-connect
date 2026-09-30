import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtMoney, fmtDate } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Field, Segmented, Stat, useToast, Banner,
} from '../../components/ui.jsx';
import { AuthedImage } from '../../components/AuthedImage.jsx';
import { INCIDENT_SEVERITY } from '@shared/domain.js';
import { AddFollowUp, FollowUpList, FollowUpsTab, useOwners } from './FollowUps.jsx';

function ReviewDialog({ id, onClose, onSaved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ status: 'under_review', reviewNotes: '', severity: '' });
  const [busy, setBusy] = useState(false);
  const owners = useOwners();

  useEffect(() => {
    (async () => {
      try {
        const d = await api.get(`/incidents/${id}`);
        setData(d);
        setForm({
          status: d.incident.status === 'submitted' ? 'under_review' : d.incident.status,
          reviewNotes: d.incident.review_notes || '',
          severity: d.incident.severity,
        });
      } catch (err) {
        toast.error(err.message);
        onClose();
      }
    })();
  }, [id, onClose, toast]);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/incidents/${id}/review`, {
        status: form.status,
        reviewNotes: form.reviewNotes || undefined,
        severity: form.severity || undefined,
      });
      toast.success('Review saved.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Modal title="Loading" onClose={onClose}><LoadingPage /></Modal>;
  const i = data.incident;

  return (
    <Modal
      title={i.ref_number}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            Save review
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row wrap">
          <StatusChip value={i.status} />
          <StatusChip value={i.severity} />
          {i.category && <Chip kind="navy">{i.category}</Chip>}
          {Boolean(i.police_notified) && <Chip kind="info">Police notified</Chip>}
        </div>

        <dl className="kv">
          <dt>Occurred</dt>
          <dd>{fmtDateTime(i.occurred_at)}</dd>
          <dt>Officer</dt>
          <dd>
            {i.reported_by}
            {i.callback_number ? ` - ${i.callback_number}` : ''}
          </dd>
          <dt>Site / post</dt>
          <dd>
            {i.site_name || '--'}
            {i.post_name ? ` / ${i.post_name}` : ''}
          </dd>
          <dt>Location</dt>
          <dd>{i.location_text || '--'}</dd>
          {i.cost_recovery_cents != null && (
            <>
              <dt>Cost recovery</dt>
              <dd className="strong">{fmtMoney(i.cost_recovery_cents)}</dd>
            </>
          )}
          {i.police_report_number && (
            <>
              <dt>Police report</dt>
              <dd>{i.police_report_number}</dd>
            </>
          )}
        </dl>

        <div>
          <h4 className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>What happened</h4>
          <p style={{ whiteSpace: 'pre-line' }}>{i.what_happened}</p>
        </div>
        {i.resolution && (
          <div>
            <h4 className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Resolution</h4>
            <p style={{ whiteSpace: 'pre-line' }}>{i.resolution}</p>
          </div>
        )}
        {i.other_details && (
          <div>
            <h4 className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Other details</h4>
            <p style={{ whiteSpace: 'pre-line' }}>{i.other_details}</p>
          </div>
        )}
        {(i.people_involved || i.people_notified) && (
          <dl className="kv">
            {i.people_involved && (
              <>
                <dt>Involved</dt>
                <dd>{i.people_involved}</dd>
              </>
            )}
            {i.people_notified && (
              <>
                <dt>Notified</dt>
                <dd>{i.people_notified}</dd>
              </>
            )}
          </dl>
        )}

        {data.photos.length > 0 && (
          <div>
            <h4 className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Photos
            </h4>
            <div className="photo-grid">
              {data.photos.map((p) => (
                <AuthedImage
                  key={p.id}
                  src={`/incidents/${id}/photos/${p.id}`}
                  alt={p.caption || p.original_name || 'Incident photograph'}
                  onClick={(url) => window.open(url, '_blank', 'noopener')}
                />
              ))}
            </div>
          </div>
        )}

        <hr style={{ border: 0, borderTop: '1px solid var(--line)' }} />

        <section aria-labelledby="followups-title">
          <h3 id="followups-title" style={{ margin: '0 0 6px' }}>
            Follow-ups
          </h3>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            What is being done so it does not happen again. The client sees the ones marked for them, and whether each is done.
          </p>
          <div className="card" style={{ marginBottom: 12 }}>
            <FollowUpList actions={data.actions || []} onChange={(actions) => setData((d) => ({ ...d, actions }))} />
          </div>
          <AddFollowUp incidentId={i.id} owners={owners} onAdded={(actions) => setData((d) => ({ ...d, actions }))} />
        </section>

        <hr style={{ border: 0, borderTop: '1px solid var(--line)' }} />

        <fieldset>
          <legend>Supervisor review</legend>
          <div className="stack">
            <div className="grid grid-2">
              <Field label="Status">
                <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                  <option value="submitted">Submitted</option>
                  <option value="under_review">Under review</option>
                  <option value="closed">Closed</option>
                </select>
              </Field>
              <Field label="Severity" hint="Adjust if the officer under- or over-rated it.">
                <select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
                  {INCIDENT_SEVERITY.map((s) => (
                    <option key={s} value={s}>
                      {s[0].toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Review notes" hint="Visible to the reporting officer.">
              <textarea
                value={form.reviewNotes}
                onChange={(e) => setForm((f) => ({ ...f, reviewNotes: e.target.value }))}
                rows={3}
              />
            </Field>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

export default function AdminIncidentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'follow-ups' ? 'follow-ups' : 'incidents';
  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Operations</div>
        <h1>Incident reports</h1>
      </div>
      <Segmented
        label="Incidents view"
        value={tab}
        onChange={(v) => setParams(v === 'incidents' ? {} : { tab: v }, { replace: true })}
        options={[
          { value: 'incidents', label: 'Reports' },
          { value: 'follow-ups', label: 'Follow-ups' },
        ]}
      />
      {tab === 'follow-ups' ? <FollowUpsTab /> : <IncidentList />}
    </div>
  );
}

function IncidentList() {
  const toast = useToast();
  const [incidents, setIncidents] = useState(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(null);

  const load = async () => {
    try {
      const qs = new URLSearchParams({ scope: 'all', limit: '200' });
      if (status) qs.set('status', status);
      if (search.trim()) qs.set('search', search.trim());
      setIncidents((await api.get(`/incidents?${qs}`)).incidents);
    } catch (err) {
      toast.error(err.message);
      setIncidents([]);
    }
  };

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, search]);

  if (!incidents) return <LoadingPage label="Loading incidents" />;

  const open = incidents.filter((i) => i.status !== 'closed').length;
  const severe = incidents.filter((i) => ['high', 'critical'].includes(i.severity)).length;
  const recovery = incidents.reduce((n, i) => n + (i.cost_recovery_cents || 0), 0);

  return (
    <div className="stack">
      <div className="grid grid-4">
        <Stat label="Total reports" value={incidents.length} foot="Matching current filter" />
        <Stat label="Awaiting review" value={open} foot="Submitted or in review" alert={open > 0} />
        <Stat label="High / critical" value={severe} foot="Severity escalated" alert={severe > 0} />
        <Stat label="Cost recovery" value={recovery ? fmtMoney(recovery) : '--'} foot="Client-billable total" />
      </div>

      <div className="row-between wrap">
        <Segmented
          label="Incident status"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All' },
            { value: 'submitted', label: 'Submitted' },
            { value: 'under_review', label: 'In review' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search incidents"
          placeholder="Search reference or description"
          style={{ maxWidth: 300 }}
        />
      </div>

      <div className="card">
        {incidents.length === 0 ? (
          <Empty icon="alert" title="No incidents match" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Occurred</th>
                  <th>Officer</th>
                  <th>Site</th>
                  <th>Category</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th className="num">Recovery</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => setActive(i.id)}>
                    <td className="mono small strong">
                      {i.ref_number}
                      {i.photo_count > 0 && (
                        <span className="tiny muted row" style={{ gap: 3 }}>
                          <Icon name="camera" size={12} /> {i.photo_count}
                        </span>
                      )}
                    </td>
                    <td className="nowrap small">{fmtDate(i.occurred_at)}</td>
                    <td className="small">{i.reported_by}</td>
                    <td className="small muted">{i.site_name || '--'}</td>
                    <td className="small">{i.category || '--'}</td>
                    <td>
                      <StatusChip value={i.severity} />
                    </td>
                    <td>
                      <StatusChip value={i.status} />
                    </td>
                    <td className="num">{i.cost_recovery_cents ? fmtMoney(i.cost_recovery_cents) : '--'}</td>
                    <td>
                      <button className="btn btn-sm btn-ghost">Review</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {active && (
        <ReviewDialog
          id={active}
          onClose={() => setActive(null)}
          onSaved={() => {
            setActive(null);
            load();
          }}
        />
      )}
    </div>
  );
}
