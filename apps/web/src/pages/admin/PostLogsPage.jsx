import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtTime, toDateInput } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, useToast } from '../../components/ui.jsx';
import { WatchEntry, WATCH_ACTION, VIOLATION_LABEL, VIOLATION_ACTION } from '../officer/PostLogPage.jsx';
import { ActivityAdmin, IssuesAdmin, FoundAdmin, ContactsAdmin, CsvButton } from './SiteLogAdmin.jsx';

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
          <CsvButton
            path={`/post-log/admin/visitors?${scope === 'inside' ? 'onSite=1' : `date=${day}`}${siteId ? `&siteId=${siteId}` : ''}`}
            filename={scope === 'inside' ? 'visitors-on-site' : `visitors-${day}`}
          />
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
                    <div className="strong">
                      {v.full_name} {v.watchlist_name && <Chip kind="danger">Watchlist override</Chip>}
                    </div>
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

/* ------------------------------------------------------------ watchlist -- */

const BLANK = { siteId: '', fullName: '', aliases: '', description: '', vehiclePlate: '', reason: '', action: 'deny_entry', risk: 'medium', expiresOn: '' };

function WatchDialog({ entry, sites, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState(
    entry
      ? {
          siteId: entry.site_id ?? '', fullName: entry.full_name, aliases: entry.aliases || '', description: entry.description || '',
          vehiclePlate: entry.vehicle_plate || '', reason: entry.reason, action: entry.action, risk: entry.risk,
          expiresOn: entry.expires_on ? String(entry.expires_on).slice(0, 10) : '',
        }
      : BLANK
  );
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    const body = { ...form, siteId: form.siteId ? Number(form.siteId) : null, expiresOn: form.expiresOn || null };
    try {
      if (entry) await api.patch(`/post-log/admin/watchlist/${entry.id}`, body);
      else await api.post('/post-log/admin/watchlist', body);
      toast.success(entry ? 'Entry updated.' : `${form.fullName} added. Officers on post see it now.`);
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={entry ? 'Edit watchlist entry' : 'Add to the watchlist'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.fullName.trim().length < 2 || form.reason.trim().length < 5}>
            {busy ? 'Saving...' : entry ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Full name" required error={errors.fullName}>
            <input value={form.fullName} onChange={set('fullName')} maxLength={120} />
          </Field>
          <Field label="Site" hint="Leave on All sites for a company-wide ban.">
            <select value={form.siteId} onChange={set('siteId')}>
              <option value="">All sites</option>
              {sites.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Other names" hint="Comma-separated. Matching is exact, so add the spellings you expect.">
          <input value={form.aliases} onChange={set('aliases')} maxLength={200} />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={set('description')} maxLength={400} placeholder="Height, build, anything distinctive" />
        </Field>
        <Field label="Why" required error={errors.reason} hint="Officers read this at the desk.">
          <textarea rows={2} value={form.reason} onChange={set('reason')} maxLength={500} />
        </Field>
        <div className="grid grid-2">
          <Field label="Officers should">
            <select value={form.action} onChange={set('action')}>
              {Object.entries(WATCH_ACTION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Risk">
            <select value={form.risk} onChange={set('risk')}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label="Vehicle plate">
            <input value={form.vehiclePlate} onChange={set('vehiclePlate')} maxLength={16} style={{ textTransform: 'uppercase' }} />
          </Field>
          <Field label="Until" hint="Empty for no end date.">
            <input type="date" value={form.expiresOn} onChange={set('expiresOn')} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function Watchlist({ sites }) {
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/post-log/admin/watchlist${showAll ? '?all=1' : ''}`));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { entries: [], overrides: [] });
    }
  }, [showAll, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const remove = async (w) => {
    try {
      await api.patch(`/post-log/admin/watchlist/${w.id}`, { active: false });
      toast.success(`${w.full_name} taken off the watchlist.`);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      {data?.overrides?.length > 0 && (
        <Banner kind="warn" title={`${data.overrides.length} recent sign-in${data.overrides.length === 1 ? '' : 's'} despite a watchlist match`}>
          {data.overrides.slice(0, 3).map((v) => (
            <div key={v.id} className="small">
              {v.full_name} at {v.site_name}, {fmtDateTime(v.arrived_at)} by {v.logged_by_name}: {String(v.notes || '').replace(/^Watchlist match overridden: /, '')}
            </div>
          ))}
        </Banner>
      )}
      <div className="card">
        <div className="card-head wrap" style={{ gap: 10 }}>
          <Segmented
            label="Show"
            value={showAll ? 'all' : 'active'}
            onChange={(v) => setShowAll(v === 'all')}
            options={[
              { value: 'active', label: 'In force' },
              { value: 'all', label: 'Including lapsed' },
            ]}
          />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={15} /> Add person
          </button>
        </div>
        {!data ? (
          <LoadingPage label="Loading the watchlist" />
        ) : data.entries.length === 0 ? (
          <Empty icon="shield" title="Nobody on the watchlist" />
        ) : (
          <ul className="list">
            {data.entries.map((w) => (
              <li key={w.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default', opacity: w.active && !w.expired ? 1 : 0.6 }}>
                <div className="grow">
                  <WatchEntry w={w} />
                  <div className="tiny muted" style={{ marginTop: 4 }}>
                    {w.site_name || 'All sites'} · added by {w.added_by_name || 'someone'}
                    {w.overrides ? ` · ${w.overrides} override${w.overrides === 1 ? '' : 's'}` : ''}
                    {!w.active ? ' · removed' : w.expired ? ' · lapsed' : ''}
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing(w)}>
                    Edit
                  </button>
                  {w.active && (
                    <button className="btn btn-sm btn-ghost" onClick={() => remove(w)}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <WatchDialog
          entry={editing === 'new' ? null : editing}
          sites={sites}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------- vehicles -- */

function Vehicles({ siteId, sites, setSiteId }) {
  const toast = useToast();
  const [days, setDays] = useState('30');
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ days });
    if (siteId) q.set('siteId', siteId);
    api.get(`/post-log/admin/vehicles?${q}`).then(
      (d) => alive && setData(d),
      (err) => {
        toast.error(err.message);
        alive && setData({ violations: [], repeatOffenders: [] });
      }
    );
    return () => {
      alive = false;
    };
  }, [siteId, days, toast]);

  return (
    <>
      <div className="card">
        <div className="card-head wrap" style={{ gap: 10 }}>
          <h2 className="h3">Repeat offenders</h2>
          <span className="small muted">Two or more violations in {data ? Math.round(data.windowDays / 30) : 6} months</span>
        </div>
        {!data ? (
          <LoadingPage label="Loading" />
        ) : data.repeatOffenders.length === 0 ? (
          <Empty icon="shield" title="No repeat offenders" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Plate</th>
                  <th>Violations</th>
                  <th>Kinds</th>
                  <th>Towed</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {data.repeatOffenders.map((r) => (
                  <tr key={r.plate}>
                    <td className="mono strong">{r.plate}</td>
                    <td>
                      <Chip kind={r.n >= 3 ? 'danger' : 'warn'}>{r.n}</Chip>
                    </td>
                    <td className="small">
                      {String(r.kinds || '')
                        .split(',')
                        .map((k) => VIOLATION_LABEL[k] || k)
                        .join(', ')}
                    </td>
                    <td className="small">{r.towed || '--'}</td>
                    <td className="small">{fmtDateTime(r.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head wrap" style={{ gap: 10 }}>
          <h2 className="h3">Violations</h2>
          <div className="row wrap" style={{ gap: 8 }}>
            <select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 'auto' }}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
            <select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: 'auto', maxWidth: 260 }}>
              <option value="">All sites</option>
              {sites.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <CsvButton path={`/post-log/admin/vehicles?days=${days}${siteId ? `&siteId=${siteId}` : ''}`} filename={`vehicle-violations-${days}-days`} />
          </div>
        </div>
        {!data ? null : data.violations.length === 0 ? (
          <Empty icon="shield" title="No violations in this period" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Plate</th>
                  <th>Violation</th>
                  <th>Action</th>
                  <th>Where</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.violations.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <span className="mono strong">{v.plate}</span>
                      {v.plate_count > 1 && (
                        <div>
                          <Chip kind="danger">x{v.plate_count}</Chip>
                        </div>
                      )}
                      {v.vehicle_desc && <div className="tiny muted">{v.vehicle_desc}</div>}
                    </td>
                    <td className="small">{VIOLATION_LABEL[v.violation] || v.violation}</td>
                    <td>
                      <Chip kind={v.action === 'towed' || v.action === 'booted' ? 'danger' : v.action === 'tagged' ? 'warn' : ''}>
                        {VIOLATION_ACTION[v.action] || v.action}
                      </Chip>
                    </td>
                    <td className="small">
                      {v.site_name}
                      {v.location_text && <div className="tiny muted">{v.location_text}</div>}
                    </td>
                    <td className="small">
                      {fmtDateTime(v.occurred_at)}
                      {v.logged_by_name && <div className="tiny muted">{v.logged_by_name}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export default function PostLogsPage() {
  const [params, setParams] = useSearchParams();
  const tab = ['passdown', 'watchlist', 'vehicles', 'activity', 'issues', 'found', 'contacts'].includes(params.get('tab')) ? params.get('tab') : 'visitors';
  const [siteId, setSiteId] = useState('');
  const [sites, setSites] = useState([]);
  useEffect(() => {
    api.get('/post-log/admin/visitors?onSite=1').then((d) => setSites(d.sites || []), () => {});
  }, []);

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Operations</div>
        <h1>Post logs</h1>
        <p className="lead">Everything recorded on post: visitors, the activity log, pass-down, building issues, lost property, the watchlist and vehicles.</p>
      </div>
      <Segmented
        label="Log"
        value={tab}
        onChange={(v) => setParams(v === 'visitors' ? {} : { tab: v }, { replace: true })}
        options={[
          { value: 'visitors', label: 'Visitors' },
          { value: 'activity', label: 'Activity' },
          { value: 'passdown', label: 'Pass-down' },
          { value: 'issues', label: 'Building issues' },
          { value: 'found', label: 'Lost & found' },
          { value: 'watchlist', label: 'Watchlist' },
          { value: 'vehicles', label: 'Vehicles' },
          { value: 'contacts', label: 'Site contacts' },
        ]}
      />
      {tab === 'contacts' ? (
        <ContactsAdmin sites={sites} siteId={siteId} setSiteId={setSiteId} />
      ) : tab === 'activity' ? (
        <ActivityAdmin sites={sites} siteId={siteId} setSiteId={setSiteId} />
      ) : tab === 'issues' ? (
        <IssuesAdmin sites={sites} siteId={siteId} setSiteId={setSiteId} />
      ) : tab === 'found' ? (
        <FoundAdmin />
      ) : tab === 'visitors' ? (
        <Visitors siteId={siteId} setSiteId={setSiteId} />
      ) : tab === 'passdown' ? (
        <Passdown siteId={siteId} />
      ) : tab === 'watchlist' ? (
        <Watchlist sites={sites} />
      ) : (
        <Vehicles siteId={siteId} setSiteId={setSiteId} sites={sites} />
      )}
    </div>
  );
}
