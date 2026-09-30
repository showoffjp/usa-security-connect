import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative, toLocalInput } from '../../lib/format.js';
import { Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, Stat, useToast } from '../../components/ui.jsx';
import { VISIT_CHECKS, VISIT_DUE_DAYS } from '@shared/domain.js';

/** Log a post visit from the desk, after the fact or for a colleague's walk-round. */
function LogVisit({ sites, posts, officers, initialSiteId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    siteId: initialSiteId ? String(initialSiteId) : '',
    postId: '',
    officerId: '',
    visitedAt: toLocalInput(new Date()),
    checks: Object.fromEntries(VISIT_CHECKS.map((c) => [c.key, true])),
    rating: 5,
    notes: '',
    clientNote: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const sitePosts = posts.filter((p) => String(p.site_id) === form.siteId);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const d = await api.post('/visits', {
        siteId: Number(form.siteId),
        postId: form.postId ? Number(form.postId) : null,
        officerId: form.officerId ? Number(form.officerId) : null,
        visitedAt: new Date(form.visitedAt).toISOString(),
        uniformOk: form.checks.uniform_ok,
        postOrdersReviewed: form.checks.post_orders_reviewed,
        equipmentOk: form.checks.equipment_ok,
        siteSecure: form.checks.site_secure,
        rating: form.rating,
        notes: form.notes || null,
        clientNote: form.clientNote || null,
      });
      toast.success('Visit logged.');
      onSaved(d.visit);
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Log a visit"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.siteId}>
            {busy ? 'Saving...' : 'Log visit'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Site" required error={errors.siteId}>
            <select value={form.siteId} onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value, postId: '' }))}>
              <option value="">Pick a site</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Post" error={errors.postId}>
            <select value={form.postId} onChange={set('postId')} disabled={!form.siteId}>
              <option value="">The site as a whole</option>
              {sitePosts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Officer on post" error={errors.officerId}>
            <select value={form.officerId} onChange={set('officerId')}>
              <option value="">Nobody on post</option>
              {officers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.first_name} {o.last_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When" error={errors.visitedAt} hint="Within the last week.">
            <input type="datetime-local" value={form.visitedAt} onChange={set('visitedAt')} />
          </Field>
        </div>

        <fieldset className="visit-checks">
          <legend>Checks</legend>
          {VISIT_CHECKS.map((c) => (
            <label key={c.key} className="check">
              <input
                type="checkbox"
                checked={form.checks[c.key]}
                onChange={(e) => setForm((f) => ({ ...f, checks: { ...f.checks, [c.key]: e.target.checked } }))}
              />
              {c.label}
            </label>
          ))}
        </fieldset>

        <div>
          <div className="small strong" style={{ marginBottom: 6 }}>
            Overall rating
          </div>
          <Segmented
            label="Overall rating"
            value={form.rating}
            onChange={(v) => setForm((f) => ({ ...f, rating: v }))}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))}
          />
        </div>

        <Field label="Notes (internal)" hint="What you saw and anything you coached the officer on. Never shown to the client.">
          <textarea rows={3} value={form.notes} onChange={set('notes')} maxLength={3000} />
        </Field>
        <Field label="Note for the client" hint="What the property's contacts read in the portal. Leave it empty to show the visit alone.">
          <textarea rows={2} value={form.clientNote} onChange={set('clientNote')} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

function VisitList({ visits }) {
  if (!visits.length) return <Empty icon="shield" title="No visits match" />;
  return (
    <ul className="list visit-list">
      {visits.map((v) => {
        const problem = v.failed.length > 0 || (v.rating != null && v.rating <= 2);
        return (
          <li key={v.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
            <span className={`lead-icon ${problem ? 'fu-overdue' : 'fu-done'}`} aria-hidden="true">
              <Icon name={problem ? 'alert' : 'check'} size={16} />
            </span>
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                <strong className="small">
                  {v.site_name}
                  {v.post_name ? ` · ${v.post_name}` : ''}
                </strong>
                {v.rating != null && <Chip kind={v.rating <= 2 ? 'danger' : v.rating >= 4 ? 'ok' : ''}>Rated {v.rating} of 5</Chip>}
                {v.failed.map((f) => (
                  <Chip key={f} kind="danger">
                    {f}
                  </Chip>
                ))}
              </div>
              <div className="tiny muted">
                {fmtDateTime(v.visited_at)} · {v.supervisor_name}
                {v.officer_name ? ` with ${v.officer_name}` : ''}
              </div>
              {v.notes && <div className="small" style={{ marginTop: 3 }}>{v.notes}</div>}
              {v.client_note && (
                <div className="tiny muted" style={{ marginTop: 3 }}>
                  <strong>Client reads:</strong> {v.client_note}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Field supervision: which sites are due a visit, and what every visit found.
 * Visits are logged on the phone at the post; this is the desk view, and a
 * way to log one after the fact.
 */
export default function VisitsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const issues = params.get('issues') === '1';
  const [siteId, setSiteId] = useState('');
  const [board, setBoard] = useState(null);
  const [visits, setVisits] = useState(null);
  const [ref, setRef] = useState({ sites: [], posts: [] });
  const [officers, setOfficers] = useState([]);
  const [logging, setLogging] = useState(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ days: '60', limit: '100' });
      if (issues) qs.set('issues', '1');
      if (siteId) qs.set('siteId', siteId);
      const [b, v] = await Promise.all([api.get('/visits/board'), api.get(`/visits?${qs}`)]);
      setBoard(b);
      setVisits(v.visits);
    } catch (err) {
      toast.error(err.message);
      setBoard((b) => b || { sites: [], due: 0 });
      setVisits([]);
    }
  }, [issues, siteId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get('/reference').then(setRef, () => {});
    api.get('/admin/employees').then(
      (d) => setOfficers((d.employees || []).filter((e) => e.status === 'active')),
      () => {}
    );
  }, []);

  const stats = useMemo(() => {
    const sites = board?.sites || [];
    const visited = sites.reduce((n, s) => n + s.visits_30, 0);
    const rated = sites.filter((s) => s.rating_30 != null);
    return {
      visited,
      rating: rated.length ? (rated.reduce((n, s) => n + s.rating_30, 0) / rated.length).toFixed(1) : '--',
    };
  }, [board]);

  if (!board || !visits) return <LoadingPage label="Loading field visits" />;

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="eyebrow">Operations</div>
          <h1>Field visits</h1>
          <p className="lead">Supervisor visits to every post, and the sites that have gone longest without one.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setLogging({ siteId: null })}>
          <Icon name="plus" size={16} /> Log a visit
        </button>
      </div>

      <div className="grid grid-4">
        <Stat label="Due a visit" value={board.due} foot={`No visit in ${VISIT_DUE_DAYS} days`} alert={board.due > 0} />
        <Stat label="Visits" value={stats.visited} foot="Last 30 days" />
        <Stat label="Average rating" value={stats.rating} foot="Out of 5, last 30 days" />
        <Stat label="Sites" value={board.sites.length} foot="Active" />
      </div>

      <section className="card" aria-labelledby="visit-board-title">
        <div className="card-head">
          <h2 id="visit-board-title">Sites, longest without a visit first</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Site</th>
                <th>Last visit</th>
                <th className="num">Visits, 30 days</th>
                <th className="num">Rating</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {board.sites.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="strong">{s.name}</span>
                    <div className="tiny muted">{[s.client_name, s.city].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="small">
                    {s.last_visit ? fmtRelative(s.last_visit) : 'Never'}
                    {s.due && (
                      <div>
                        <Chip kind="danger">Due</Chip>
                      </div>
                    )}
                  </td>
                  <td className="num small">{s.visits_30}</td>
                  <td className="num small">{s.rating_30 ?? '--'}</td>
                  <td className="num">
                    <button className="btn btn-sm" onClick={() => setLogging({ siteId: s.id })} aria-label={`Log a visit to ${s.name}`}>
                      Log a visit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack-sm" aria-labelledby="visit-list-title">
        <h2 id="visit-list-title" style={{ margin: 0 }}>
          Visits, last 60 days
        </h2>
        <div className="row-between wrap" style={{ gap: 8 }}>
          <Segmented
            label="Which visits"
            value={issues ? 'issues' : 'all'}
            onChange={(v) => setParams(v === 'issues' ? { issues: '1' } : {}, { replace: true })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'issues', label: 'Found a problem' },
            ]}
          />
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site" style={{ maxWidth: 300 }}>
            <option value="">Every site</option>
            {board.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="card">
          <VisitList visits={visits} />
        </div>
      </section>

      {logging && (
        <LogVisit
          sites={ref.sites}
          posts={ref.posts}
          officers={officers}
          initialSiteId={logging.siteId}
          onClose={() => setLogging(null)}
          onSaved={() => {
            setLogging(null);
            load();
          }}
        />
      )}
    </div>
  );
}
