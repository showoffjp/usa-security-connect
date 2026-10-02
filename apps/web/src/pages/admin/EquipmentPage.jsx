import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, Stat, Modal, Field, Banner, Segmented, useToast,
} from '../../components/ui.jsx';
import {
  EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_LABEL,
  EQUIPMENT_STATUS_LABEL, EQUIPMENT_CONDITIONS,
} from '@shared/domain.js';

/**
 * Keys, radios, vehicles and firearms.
 *
 * The question this screen answers first is "who has it", not "what do we own"
 * - an inventory count is a year-end job, but finding the officer holding a
 * building's master keys is a today job. So the holder is a column, the search
 * matches their name as well as the item, and anything signed out sorts up.
 */

const CONDITION_LABEL = { good: 'Good', worn: 'Worn', damaged: 'Damaged' };

/* ------------------------------------------------------------ issue --- */

function IssueDialog({ item, people, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ userId: '', condition: 'good', note: '' });

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/equipment/${item.id}/issue`, {
        userId: Number(form.userId),
        condition: form.condition,
        note: form.note.trim() || null,
      });
      toast.success('Signed out.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Sign out ${item.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.userId}>
            {busy ? 'Saving' : 'Sign it out'}
          </button>
        </>
      }
    >
      {item.armed_only && (
        <Banner kind="warn" title="Class G required">
          Only an officer with a current armed licence can take this. Anyone else
          is refused, with the reason.
        </Banner>
      )}

      <Field label="To" required>
        <select value={form.userId} onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}>
          <option value="">Choose an officer</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.first_name} {p.last_name} ({p.employee_code})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Condition handed over" hint="What it looked like going out, so a dispute later has two readings.">
        <select value={form.condition} onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value }))}>
          {EQUIPMENT_CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
        </select>
      </Field>

      <Field label="Note">
        <input
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          placeholder="Night shift, back at 06:00"
        />
      </Field>
    </Modal>
  );
}

/* ----------------------------------------------------------- return --- */

function ReturnDialog({ item, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ condition: 'good', note: '' });

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/equipment/${item.id}/return`, {
        condition: form.condition,
        note: form.note.trim() || null,
      });
      toast.success(form.condition === 'good' ? 'Back on the shelf.' : 'Taken back, sent to maintenance.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Take back ${item.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving' : 'Take it back'}
          </button>
        </>
      }
    >
      <p className="small muted">
        Signed out to {item.holder_first} {item.holder_last} ({item.holder_code}),{' '}
        {fmtRelative(item.issued_at)}.
      </p>

      <Field
        label="Condition coming back"
        hint="Anything but good sends it to maintenance rather than back on the shelf."
      >
        <select value={form.condition} onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value }))}>
          {EQUIPMENT_CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
        </select>
      </Field>

      <Field label="Note">
        <input
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          placeholder="Aerial bent, still transmits"
        />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------------- history --- */

function HistoryDialog({ item, onClose }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api
      .get(`/equipment/${item.id}/history`)
      .then((d) => setRows(d.history))
      .catch((err) => {
        toast.error(err.message);
        setRows([]);
      });
  }, [item.id, toast]);

  return (
    <Modal title={`Chain of custody - ${item.label}`} onClose={onClose} wide>
      {!rows ? (
        <LoadingPage label="Loading" />
      ) : rows.length === 0 ? (
        <Empty icon="clipboard" title="Never signed out" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Held by</th>
                <th>Out</th>
                <th>Back</th>
                <th>Condition</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="strong small">{r.first_name} {r.last_name}</div>
                    <div className="tiny muted mono">{r.employee_code}</div>
                  </td>
                  <td className="nowrap small">
                    {fmtDateTime(r.issued_at)}
                    {r.issued_by_first && (
                      <div className="tiny muted">by {r.issued_by_first} {r.issued_by_last}</div>
                    )}
                  </td>
                  <td className="nowrap small">
                    {r.returned_at ? fmtDateTime(r.returned_at) : <Chip kind="warn">Still out</Chip>}
                  </td>
                  <td className="small">
                    {CONDITION_LABEL[r.issued_condition] || '--'}
                    {r.returned_condition && ` → ${CONDITION_LABEL[r.returned_condition]}`}
                  </td>
                  <td className="small muted">{r.returned_note || r.issued_note || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------- page -- */

export default function EquipmentPage() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [issuing, setIssuing] = useState(null);
  const [returning, setReturning] = useState(null);
  const [showing, setShowing] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/equipment'));
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { equipment: [], summary: {} });
    }
  }, [toast]);

  useEffect(() => {
    load();
    api
      .get('/admin/employees')
      .then((d) => setPeople((d.employees || []).filter((e) => e.status === 'active')))
      .catch(() => setPeople([]));
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.equipment
      .filter((e) => {
        if (tab === 'out' && !e.holder_id) return false;
        if (tab === 'available' && e.status !== 'available') return false;
        if (tab === 'attention' && e.status !== 'maintenance' && e.status !== 'lost') return false;
        if (!q) return true;
        const holder = e.holder_id ? `${e.holder_first} ${e.holder_last} ${e.holder_code}` : '';
        return [e.label, e.identifier, e.site_name, holder].filter(Boolean).join(' ').toLowerCase().includes(q);
      })
      // Anything in somebody's hands sorts first: that is what this screen is for.
      .sort((a, b) => (b.holder_id ? 1 : 0) - (a.holder_id ? 1 : 0));
  }, [data, tab, query]);

  if (!data) return <LoadingPage label="Loading the equipment room" />;
  const s = data.summary;

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Operations</div>
          <h1>Keys &amp; equipment</h1>
          <p className="lead">
            What has been handed out, to whom, and what has not come back.
          </p>
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="On the inventory" value={s.total || 0} foot="Active items" />
        <Stat label="Signed out" value={s.issued || 0} foot="With an officer now" />
        <Stat label="Available" value={s.available || 0} foot="On the shelf" />
        <Stat
          label="Needs attention"
          value={(s.maintenance || 0) + (s.lost || 0)}
          foot={`${s.maintenance || 0} in maintenance, ${s.lost || 0} missing`}
          alert={(s.maintenance || 0) + (s.lost || 0) > 0}
        />
      </div>

      <div className="row-between wrap">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: `All ${data.equipment.length}` },
            { value: 'out', label: `Signed out ${s.issued || 0}` },
            { value: 'available', label: 'Available' },
            { value: 'attention', label: 'Needs attention' },
          ]}
        />
        <input
          type="search"
          aria-label="Search equipment or holder"
          placeholder="Radio, key ring, site or officer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 'auto', minWidth: 'min(240px, 100%)' }}
        />
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <Empty icon="clipboard" title="Nothing here">
            No item matches that filter.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th>Held by</th>
                  <th>Since</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="strong small">
                        {e.label}
                        {e.armed_only && <Chip kind="warn">Class G</Chip>}
                      </div>
                      <div className="tiny muted mono">
                        {EQUIPMENT_CATEGORY_LABEL[e.category] || e.category}
                        {e.identifier ? ` · ${e.identifier}` : ''}
                        {!e.return_by_end_of_shift && ' · kept between shifts'}
                      </div>
                    </td>
                    <td className="small">{e.site_name || <span className="muted">Company-wide</span>}</td>
                    <td>
                      <Chip kind={e.status === 'available' ? 'ok' : e.status === 'issued' ? 'brand' : 'warn'}>
                        {EQUIPMENT_STATUS_LABEL[e.status] || e.status}
                      </Chip>
                    </td>
                    <td>
                      {e.holder_id ? (
                        <>
                          <Link to={`/admin/employees/${e.holder_id}`}>
                            {e.holder_first} {e.holder_last}
                          </Link>
                          <div className="tiny muted mono">{e.holder_code}</div>
                        </>
                      ) : (
                        <span className="muted small">--</span>
                      )}
                    </td>
                    <td className="nowrap small">
                      {e.issued_at ? fmtRelative(e.issued_at) : <span className="muted">--</span>}
                    </td>
                    <td className="num nowrap">
                      <div className="row">
                        {e.holder_id ? (
                          <button className="btn btn-ghost btn-sm" onClick={() => setReturning(e)}>
                            Take back
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setIssuing(e)}
                            disabled={e.status !== 'available'}
                          >
                            Sign out
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowing(e)}>
                          History
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="tiny muted">
        Anything marked to come back at the end of a shift raises a flag if the officer
        clocks out still holding it. A vehicle assigned for a stretch does not.
        {!isAdmin && ' Adding or retiring an item is an administrator job.'}
      </p>

      {issuing && (
        <IssueDialog
          item={issuing}
          people={people}
          onClose={() => setIssuing(null)}
          onSaved={() => { setIssuing(null); load(); }}
        />
      )}
      {returning && (
        <ReturnDialog
          item={returning}
          onClose={() => setReturning(null)}
          onSaved={() => { setReturning(null); load(); }}
        />
      )}
      {showing && <HistoryDialog item={showing} onClose={() => setShowing(null)} />}
    </div>
  );
}
