import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtTime, toDateInput } from '../../lib/format.js';
import { Chip, Empty, LoadingPage, Segmented, useToast } from '../../components/ui.jsx';

const KIND_LABEL = { visitor: 'Visitor', contractor: 'Contractor', delivery: 'Delivery', vendor: 'Vendor', other: 'Other' };

function Visitors({ siteId, setSiteId }) {
  const toast = useToast();
  const [scope, setScope] = useState('inside');
  const [day, setDay] = useState(toDateInput(new Date()));
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (siteId) q.set('siteId', siteId);
    if (scope === 'inside') q.set('onSite', '1');
    else q.set('date', day);
    try {
      setData(await api.get(`/post-log/admin/visitors?${q}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { visitors: [], sites: [], onSiteTotal: 0 });
    }
  }, [siteId, scope, day, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const depart = async (v) => {
    try {
      await api.post(`/post-log/visitors/${v.id}/depart`);
      toast.success(`${v.full_name} signed out.`);
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
          value={scope}
          onChange={setScope}
          options={[
            { value: 'inside', label: `On site now${data ? ` (${data.onSiteTotal})` : ''}` },
            { value: 'day', label: 'By day' },
          ]}
        />
        <div className="row wrap" style={{ gap: 8 }}>
          {scope === 'day' && (
            <input type="date" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 'auto' }} />
          )}
          <select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All sites</option>
            {(data?.sites || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {Number(s.on_site) ? ` (${s.on_site} inside)` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!data ? (
        <LoadingPage label="Loading visitors" />
      ) : data.visitors.length === 0 ? (
        <Empty icon="users" title={scope === 'inside' ? 'Nobody signed in anywhere' : 'No visitors that day'}>
          Officers sign visitors in from the post log on their phone.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Visitor</th>
                <th>Here for</th>
                <th>Vehicle</th>
                <th>Site</th>
                <th>In</th>
                <th>Out</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.visitors.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div className="strong">{v.full_name}</div>
                    <div className="tiny muted">
                      {KIND_LABEL[v.kind] || v.kind}
                      {v.company ? ` · ${v.company}` : ''}
                      {v.badge_number ? ` · ${v.badge_number}` : ''}
                    </div>
                  </td>
                  <td>
                    <div className="small">{v.purpose}</div>
                    {v.host && <div className="tiny muted">for {v.host}</div>}
                  </td>
                  <td className="small">
                    {v.vehicle_plate ? <span className="mono">{v.vehicle_plate}</span> : <span className="muted">--</span>}
                    {v.vehicle_desc && <div className="tiny muted">{v.vehicle_desc}</div>}
                  </td>
                  <td className="small">
                    {v.site_name}
                    {v.post_name && <div className="tiny muted">{v.post_name}</div>}
                  </td>
                  <td className="small">
                    {fmtDateTime(v.arrived_at)}
                    {v.logged_by_name && <div className="tiny muted">{v.logged_by_name}</div>}
                  </td>
                  <td className="small">
                    {v.departed_at ? fmtTime(v.departed_at) : <Chip kind="warn">Inside</Chip>}
                  </td>
                  <td>
                    {!v.departed_at && (
                      <button className="btn btn-sm btn-ghost" onClick={() => depart(v)}>
                        Sign out
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

function Passdown({ siteId }) {
  const toast = useToast();
  const [days, setDays] = useState('7');
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ days });
    if (siteId) q.set('siteId', siteId);
    api.get(`/post-log/admin/passdown?${q}`).then(
      (d) => alive && setData(d),
      (err) => {
        toast.error(err.message);
        alive && setData({ notes: [] });
      }
    );
    return () => {
      alive = false;
    };
  }, [siteId, days, toast]);

  return (
    <div className="card">
      <div className="card-head wrap">
        <h2 className="h3">Pass-down notes</h2>
        <select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 'auto' }}>
          <option value="2">Last 2 days</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
        </select>
      </div>
      {!data ? (
        <LoadingPage label="Loading notes" />
      ) : data.notes.length === 0 ? (
        <Empty icon="clipboard" title="No notes in this period">
          Officers leave pass-down notes for the next shift from the post log.
        </Empty>
      ) : (
        <ul className="list">
          {data.notes.map((n) => (
            <li key={n.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="strong small">{n.post_name}</span>
                  <span className="tiny muted">{n.site_name}</span>
                  {n.priority === 'important' && <Chip kind="danger">Important</Chip>}
                </div>
                <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {n.author_name || 'Someone'} · {fmtDateTime(n.created_at)} ·{' '}
                  {n.acks.length ? (
                    <>read by {n.acks.map((a) => a.name).join(', ')}</>
                  ) : (
                    <strong style={{ color: 'var(--warn)' }}>not read yet</strong>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PostLogsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'passdown' ? 'passdown' : 'visitors';
  const [siteId, setSiteId] = useState('');

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Operations</div>
        <h1>Post logs</h1>
        <p className="lead">Who is inside each site, who came through, and what each shift left for the next.</p>
      </div>
      <Segmented
        label="Log"
        value={tab}
        onChange={(v) => setParams(v === 'passdown' ? { tab: 'passdown' } : {}, { replace: true })}
        options={[
          { value: 'visitors', label: 'Visitors' },
          { value: 'passdown', label: 'Pass-down' },
        ]}
      />
      {tab === 'visitors' ? <Visitors siteId={siteId} setSiteId={setSiteId} /> : <Passdown siteId={siteId} />}
    </div>
  );
}
