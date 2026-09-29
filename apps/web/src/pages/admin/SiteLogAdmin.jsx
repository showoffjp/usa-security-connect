import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtTime, toDateInput } from '../../lib/format.js';
import { Chip, Empty, LoadingPage, Segmented, useToast } from '../../components/ui.jsx';
import { ACTIVITY_LABEL, ISSUE_LABEL, ISSUE_STATUS, FOUND_LABEL } from '../officer/SiteLogTabs.jsx';

function SiteSelect({ sites, value, onChange }) {
  return (
    <select aria-label="Site" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto', maxWidth: 260 }}>
      <option value="">All sites</option>
      {sites.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );
}

/* --------------------------------------------------------------- activity -- */

export function ActivityAdmin({ sites, siteId, setSiteId }) {
  const toast = useToast();
  const [day, setDay] = useState(toDateInput(new Date()));
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ date: day });
    if (siteId) q.set('siteId', siteId);
    api.get(`/post-log/admin/activity?${q}`).then(
      (d) => alive && setData(d),
      (err) => {
        toast.error(err.message);
        alive && setData({ entries: [] });
      }
    );
    return () => {
      alive = false;
    };
  }, [day, siteId, toast]);

  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <h2 className="h3">Activity log</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          <input type="date" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 'auto' }} />
          <SiteSelect sites={sites} value={siteId} onChange={setSiteId} />
        </div>
      </div>
      {!data ? (
        <LoadingPage label="Loading" />
      ) : data.entries.length === 0 ? (
        <Empty icon="clipboard" title="Nothing logged that day" />
      ) : (
        <ul className="list">
          {data.entries.map((a) => (
            <li key={a.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
              <div className="nowrap small strong" style={{ width: 62 }}>{fmtTime(a.occurred_at)}</div>
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  <Chip>{ACTIVITY_LABEL[a.category] || a.category}</Chip>
                  {!a.client_visible && <Chip kind="navy">Internal</Chip>}
                  <span className="tiny muted">
                    {a.officer_name} · {a.site_name}
                    {a.post_name ? `, ${a.post_name}` : ''}
                  </span>
                </div>
                <div className="small" style={{ marginTop: 4 }}>{a.body}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- issues -- */

export function IssuesAdmin({ sites, siteId, setSiteId }) {
  const toast = useToast();
  const [status, setStatus] = useState('unresolved');
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ status });
    if (siteId) q.set('siteId', siteId);
    try {
      setData(await api.get(`/post-log/admin/issues?${q}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { issues: [], counts: {} });
    }
  }, [status, siteId, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const setIssue = async (i, next) => {
    try {
      await api.post(`/post-log/issues/${i.id}/status`, { status: next });
      toast.success(next === 'fixed' ? 'Marked fixed.' : 'Reopened.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const c = data?.counts || {};
  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <Segmented
          label="Show"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'unresolved', label: `Unresolved (${(c.open || 0) + (c.acknowledged || 0)})` },
            { value: 'open', label: 'Not yet seen' },
            { value: 'fixed', label: 'Fixed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <SiteSelect sites={sites} value={siteId} onChange={setSiteId} />
      </div>
      {!data ? (
        <LoadingPage label="Loading" />
      ) : data.issues.length === 0 ? (
        <Empty icon="building" title="No issues here" />
      ) : (
        <ul className="list">
          {data.issues.map((i) => {
            const [kind, label] = ISSUE_STATUS[i.status] || ['', i.status];
            return (
              <li key={i.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="strong small">
                      {ISSUE_LABEL[i.category] || i.category} · {i.site_name}
                    </span>
                    {i.priority === 'urgent' && <Chip kind="danger">Urgent</Chip>}
                    <Chip kind={kind}>{label}</Chip>
                  </div>
                  {i.location_text && <div className="tiny muted">{i.location_text}</div>}
                  <div className="small" style={{ marginTop: 3 }}>{i.description}</div>
                  {i.client_note && (
                    <div className="small" style={{ marginTop: 4 }}>
                      <strong>Client:</strong> {i.client_note}
                    </div>
                  )}
                  <div className="tiny muted" style={{ marginTop: 3 }}>
                    Reported by {i.reported_by_name} {fmtDateTime(i.created_at)}
                    {i.fixed_at ? ` · fixed ${fmtDateTime(i.fixed_at)} by ${i.closed_by_client_name || i.closed_by_staff_name || 'someone'}` : ''}
                  </div>
                </div>
                {i.status === 'fixed' ? (
                  <button className="btn btn-sm btn-ghost" onClick={() => setIssue(i, 'open')}>
                    Reopen
                  </button>
                ) : (
                  <button className="btn btn-sm btn-ghost" onClick={() => setIssue(i, 'fixed')}>
                    Mark fixed
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- lost & found -- */

export function FoundAdmin() {
  const toast = useToast();
  const [status, setStatus] = useState('held');
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/post-log/admin/found?status=${status}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { items: [], overdue: 0 });
    }
  }, [status, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const dispose = async (f) => {
    try {
      await api.post(`/post-log/found/${f.id}/close`, { status: 'disposed' });
      toast.success('Recorded as disposed of.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="card">
      <div className="card-head wrap" style={{ gap: 10 }}>
        <Segmented
          label="Show"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'held', label: 'Held' },
            { value: 'returned', label: 'Returned' },
            { value: 'disposed', label: 'Disposed' },
            { value: 'all', label: 'All' },
          ]}
        />
        {data?.overdue > 0 && <Chip kind="warn">{data.overdue} held over 30 days</Chip>}
      </div>
      {!data ? (
        <LoadingPage label="Loading" />
      ) : data.items.length === 0 ? (
        <Empty icon="clipboard" title="Nothing here" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Site</th>
                <th>Found</th>
                <th>Kept / left with</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((f) => (
                <tr key={f.id}>
                  <td>
                    <div className="strong small">{f.description}</div>
                    <div className="tiny muted">{FOUND_LABEL[f.category] || f.category}</div>
                  </td>
                  <td className="small">
                    {f.site_name}
                    {f.found_location && <div className="tiny muted">{f.found_location}</div>}
                  </td>
                  <td className="small">
                    {fmtDateTime(f.found_at)}
                    <div className="tiny muted">{f.found_by_name}</div>
                  </td>
                  <td className="small">
                    {f.status === 'held' ? (
                      f.stored_location
                    ) : f.status === 'returned' ? (
                      <>
                        {f.returned_to}
                        <div className="tiny muted">
                          {f.returned_contact} · {f.closed_by_name}, {fmtDateTime(f.closed_at)}
                        </div>
                      </>
                    ) : (
                      <span className="muted">Disposed of {fmtDateTime(f.closed_at)}</span>
                    )}
                  </td>
                  <td>
                    {f.status === 'held' && (
                      <button className="btn btn-sm btn-ghost" onClick={() => dispose(f)}>
                        Dispose
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
