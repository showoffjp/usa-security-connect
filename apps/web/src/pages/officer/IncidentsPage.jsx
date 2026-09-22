import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtMoney } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, StatusChip, Chip, useToast, Modal } from '../../components/ui.jsx';
import { AuthedImage } from '../../components/AuthedImage.jsx';

function IncidentDetail({ id, onClose }) {
  const toast = useToast();
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setData(await api.get(`/incidents/${id}`));
      } catch (err) {
        toast.error(err.message);
        onClose();
      }
    })();
  }, [id, onClose, toast]);

  return (
    <Modal title={data ? data.incident.ref_number : 'Loading'} onClose={onClose} wide>
      {!data ? (
        <LoadingPage />
      ) : (
        <div className="stack">
          <div className="row wrap">
            <StatusChip value={data.incident.status} />
            <StatusChip value={data.incident.severity} />
            {data.incident.category && <Chip kind="navy">{data.incident.category}</Chip>}
            {Boolean(data.incident.police_notified) && <Chip kind="info">Police notified</Chip>}
          </div>

          <dl className="kv">
            <dt>Occurred</dt>
            <dd>{fmtDateTime(data.incident.occurred_at)}</dd>
            <dt>Location</dt>
            <dd>
              {data.incident.location_text || '--'}
              {data.incident.site_name ? ` (${data.incident.site_name})` : ''}
            </dd>
            <dt>Reported by</dt>
            <dd>{data.incident.reported_by}</dd>
            {data.incident.callback_number && (
              <>
                <dt>Callback</dt>
                <dd>{data.incident.callback_number}</dd>
              </>
            )}
            {data.incident.cost_recovery_cents != null && (
              <>
                <dt>Cost recovery</dt>
                <dd>{fmtMoney(data.incident.cost_recovery_cents)}</dd>
              </>
            )}
          </dl>

          <div>
            <h4 className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              What happened
            </h4>
            <p style={{ whiteSpace: 'pre-line' }}>{data.incident.what_happened}</p>
          </div>

          {data.incident.resolution && (
            <div>
              <h4 className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                How it was resolved
              </h4>
              <p style={{ whiteSpace: 'pre-line' }}>{data.incident.resolution}</p>
            </div>
          )}

          {data.incident.other_details && (
            <div>
              <h4 className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Other details
              </h4>
              <p style={{ whiteSpace: 'pre-line' }}>{data.incident.other_details}</p>
            </div>
          )}

          {(data.incident.people_involved || data.incident.people_notified) && (
            <dl className="kv">
              {data.incident.people_involved && (
                <>
                  <dt>People involved</dt>
                  <dd>{data.incident.people_involved}</dd>
                </>
              )}
              {data.incident.people_notified && (
                <>
                  <dt>People notified</dt>
                  <dd>{data.incident.people_notified}</dd>
                </>
              )}
            </dl>
          )}

          {data.photos.length > 0 && (
            <div>
              <h4 className="muted tiny" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Photos ({data.photos.length})
              </h4>
              <div className="photo-grid">
                {data.photos.map((p) => (
                  <AuthedImage
                    key={p.id}
                    src={`/incidents/${id}/photos/${p.id}`}
                    alt={p.caption || p.original_name || 'Incident photograph'}
                  />
                ))}
              </div>
            </div>
          )}

          {data.incident.review_notes && (
            <div className="banner banner-info">
              <Icon name="clipboard" size={18} />
              <div>
                <strong>Supervisor review - {data.incident.reviewed_by_name}</strong>
                {data.incident.review_notes}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function IncidentsPage() {
  const toast = useToast();
  const [incidents, setIncidents] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/incidents');
        setIncidents(res.incidents);
      } catch (err) {
        toast.error(err.message);
        setIncidents([]);
      }
    })();
  }, [toast]);

  if (!incidents) return <LoadingPage label="Loading your reports" />;

  return (
    <div className="page stack">
      <div className="row-between">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Documentation</div>
          <h1>My reports</h1>
        </div>
        <Link className="btn btn-primary" to="/incidents/new">
          <Icon name="plus" size={17} /> New report
        </Link>
      </div>

      {incidents.length === 0 ? (
        <div className="card">
          <Empty
            icon="alert"
            title="No reports filed"
            action={
              <Link className="btn btn-primary" to="/incidents/new" style={{ marginTop: 12 }}>
                Report an incident
              </Link>
            }
          >
            Anything out of the ordinary on post belongs in a report - alarms, trespass, damage or injury.
          </Empty>
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {incidents.map((i) => (
              <button key={i.id} className="list-item" onClick={() => setOpen(i.id)}>
                <div
                  className="lead-icon"
                  style={
                    ['high', 'critical'].includes(i.severity)
                      ? { background: 'var(--danger-bg)', color: 'var(--danger)' }
                      : undefined
                  }
                >
                  <Icon name="alert" size={18} />
                </div>
                <div className="grow">
                  <div className="row" style={{ gap: 7 }}>
                    <span className="strong small mono">{i.ref_number}</span>
                    <StatusChip value={i.status} />
                  </div>
                  <div className="tiny muted truncate">
                    {i.category ? `${i.category} - ` : ''}
                    {i.location_text || i.site_name}
                  </div>
                  <div className="tiny muted">{fmtDateTime(i.occurred_at)}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {i.photo_count > 0 && (
                    <span className="tiny muted row" style={{ gap: 3 }}>
                      <Icon name="camera" size={13} /> {i.photo_count}
                    </span>
                  )}
                  <StatusChip value={i.severity} />
                  <Icon name="chevron" size={16} />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {open && <IncidentDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
