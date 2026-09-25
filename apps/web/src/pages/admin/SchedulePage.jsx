import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDay, fmtTime, fmtRange, toDateInput, toLocalInput, fmtDate } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Field, Banner, Segmented, useToast,
} from '../../components/ui.jsx';
import { toHours } from '@shared/domain.js';

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function ShiftDialog({ shift, posts, employees, onClose, onSaved }) {
  const toast = useToast();
  // A shift without an id is a prefill from clicking an empty roster cell.
  const editing = Boolean(shift?.id);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState('');
  const [form, setForm] = useState({
    userId: shift?.user_id ? String(shift.user_id) : '',
    postId: shift?.post_id ? String(shift.post_id) : posts[0]?.id ? String(posts[0].id) : '',
    startsAt: toLocalInput(shift?.starts_at || new Date(Date.now() + 86400000).setHours(8, 0, 0, 0)),
    endsAt: toLocalInput(shift?.ends_at || new Date(Date.now() + 86400000).setHours(16, 0, 0, 0)),
    notes: shift?.notes || '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setConflict('');
    try {
      const payload = {
        userId: form.userId ? Number(form.userId) : null,
        postId: Number(form.postId),
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        notes: form.notes || undefined,
      };
      if (editing) await api.patch(`/admin/shifts/${shift.id}`, payload);
      else await api.post('/admin/shifts', payload);
      toast.success(editing ? 'Shift updated.' : 'Shift added.');
      onSaved();
    } catch (err) {
      if (err.status === 409) setConflict(err.message);
      else toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const res = await api.del(`/admin/shifts/${shift.id}`);
      toast.success(res.cancelled ? 'Shift cancelled (it had been worked).' : 'Shift removed.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Edit shift' : 'Add shift'}
      onClose={onClose}
      footer={
        <>
          {editing && (
            <button className="btn btn-danger btn-sm" onClick={remove} disabled={busy} style={{ marginRight: 'auto' }}>
              Remove
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.postId}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        {conflict && <Banner kind="danger" title="Scheduling conflict">{conflict}</Banner>}
        <Field label="Officer" hint="Leave unassigned to post an open shift.">
          <select value={form.userId} onChange={set('userId')}>
            <option value="">Unassigned</option>
            {employees
              .filter((e) => e.status === 'active')
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name} ({e.employee_code})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Post" required>
          <select value={form.postId} onChange={set('postId')}>
            {posts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.site_name} - {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-2">
          <Field label="Starts" required>
            <input type="datetime-local" value={form.startsAt} onChange={set('startsAt')} />
          </Field>
          <Field label="Ends" required>
            <input type="datetime-local" value={form.endsAt} onChange={set('endsAt')} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={form.notes} onChange={set('notes')} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}

function BulkDialog({ posts, employees, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({
    userId: '',
    postId: posts[0]?.id ? String(posts[0].id) : '',
    startDate: toDateInput(new Date()),
    endDate: toDateInput(new Date(Date.now() + 27 * 86400000)),
    startTime: '08:00',
    endTime: '16:00',
    weekdays: [1, 2, 3, 4, 5],
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleDay = (d) =>
    setForm((f) => ({
      ...f,
      weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d],
    }));

  const overnight = form.endTime <= form.startTime;

  const generate = async () => {
    setBusy(true);
    try {
      const res = await api.post('/admin/shifts/bulk', {
        userId: form.userId ? Number(form.userId) : null,
        postId: Number(form.postId),
        startDate: form.startDate,
        endDate: form.endDate,
        startTime: form.startTime,
        endTime: form.endTime,
        weekdays: form.weekdays,
        skipConflicts: true,
      });
      setResult(res);
      toast.success(`${res.created} shifts created.`);
      onSaved(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Build a recurring roster"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button className="btn btn-primary" onClick={generate} disabled={busy || !form.weekdays.length}>
            {busy ? 'Generating...' : 'Generate shifts'}
          </button>
        </>
      }
    >
      <div className="stack">
        {result && (
          <Banner kind={result.skipped.length ? 'warn' : 'ok'} title={`${result.created} shifts created`}>
            {result.skipped.length
              ? `${result.skipped.length} day(s) skipped because the officer was already scheduled.`
              : 'No conflicts found.'}
          </Banner>
        )}

        <div className="grid grid-2">
          <Field label="Officer">
            <select value={form.userId} onChange={set('userId')}>
              <option value="">Unassigned (open shifts)</option>
              {employees
                .filter((e) => e.status === 'active')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.full_name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Post" required>
            <select value={form.postId} onChange={set('postId')}>
              {posts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.site_name} - {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="From">
            <input type="date" value={form.startDate} onChange={set('startDate')} />
          </Field>
          <Field label="Until">
            <input type="date" value={form.endDate} onChange={set('endDate')} />
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="Start time">
            <input type="time" value={form.startTime} onChange={set('startTime')} />
          </Field>
          <Field label="End time" hint={overnight ? 'Runs overnight into the next day.' : undefined}>
            <input type="time" value={form.endTime} onChange={set('endTime')} />
          </Field>
        </div>

        <Field label="Days of the week">
          <div className="row wrap" style={{ gap: 6 }}>
            {WEEKDAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                className={`btn btn-sm ${form.weekdays.includes(d.value) ? 'btn-navy' : 'btn-ghost'}`}
                onClick={() => toggleDay(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function CopyWeekDialog({ weekStart, siteFilter, siteName, onClose, onSaved }) {
  const toast = useToast();
  const [weeksAhead, setWeeksAhead] = useState(1);
  const [keepOfficers, setKeepOfficers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const target = new Date(weekStart);
  target.setDate(target.getDate() + 7 * weeksAhead);

  const run = async () => {
    setBusy(true);
    try {
      const res = await api.post('/admin/shifts/copy-week', {
        fromWeekStart: toDateInput(weekStart),
        toWeekStart: toDateInput(target),
        siteId: siteFilter ? Number(siteFilter) : null,
        keepOfficers,
      });
      setResult(res);
      toast.success(`${res.created} shifts copied.`);
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Copy this week's roster"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button className="btn btn-primary" onClick={run} disabled={busy}>
              {busy ? 'Copying...' : 'Copy shifts'}
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        {result ? (
          <Banner kind={result.opened || result.skipped.length ? 'warn' : 'ok'} title={`${result.created} shifts created`}>
            {result.opened > 0 && `${result.opened} were left open because the officer is already booked then. `}
            {result.skipped.length > 0 && `${result.skipped.length} skipped - that post was already covered at that time.`}
            {!result.opened && !result.skipped.length && 'Every shift copied with its officer.'}
          </Banner>
        ) : (
          <>
            <p className="small" style={{ margin: 0 }}>
              Copies every shift in the week of <strong>{fmtDate(weekStart)}</strong>
              {siteFilter ? ` at ${siteName}` : ' at every site'} to the same days and times in the target week.
            </p>
            <Field label="Copy into">
              <select value={weeksAhead} onChange={(e) => setWeeksAhead(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => {
                  const d = new Date(weekStart);
                  d.setDate(d.getDate() + 7 * n);
                  return (
                    <option key={n} value={n}>
                      Week of {fmtDate(d)}
                    </option>
                  );
                })}
              </select>
            </Field>
            <label className="row small">
              <input type="checkbox" checked={keepOfficers} onChange={(e) => setKeepOfficers(e.target.checked)} style={{ width: 'auto' }} />
              Keep the same officers (clashes are left as open shifts)
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Rows of officers, columns of days: the view a scheduler actually balances hours in. */
function RosterGrid({ shifts, employees, range, siteFilter, showAll, onOpen, onAdd }) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(new Date(range.start.getTime() + i * 86400000));

  const visible = shifts.filter((s) => !siteFilter || String(s.site_id) === siteFilter);
  const byUser = new Map();
  for (const s of visible) {
    const key = s.user_id || 0;
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(s);
  }

  const people = employees
    .filter((e) => e.status === 'active' && (showAll || byUser.has(e.id)))
    .sort((a, b) => a.last_name.localeCompare(b.last_name));
  const rows = [
    ...(byUser.has(0) ? [{ id: 0, full_name: 'Open shifts', employee_code: '', employment_type: null }] : []),
    ...people,
  ];

  const hoursOf = (list) =>
    Math.round(list.reduce((n, s) => n + (new Date(s.ends_at) - new Date(s.starts_at)) / 3600000, 0) * 10) / 10;

  return (
    <div className="card">
      <div className="table-wrap">
        <table className="data roster">
          <caption className="sr-only">Roster by officer for the week</caption>
          <thead>
            <tr>
              <th style={{ minWidth: 170 }}>Officer</th>
              {days.map((d) => (
                <th key={d.toISOString()} style={d.toDateString() === new Date().toDateString() ? { color: 'var(--brand-600)' } : undefined}>
                  {fmtDay(d)}
                  <div className="tiny muted">{d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                </th>
              ))}
              <th className="num">Hours</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((person) => {
              const list = byUser.get(person.id) || [];
              const total = hoursOf(list);
              const w2 = person.employment_type === 'w2';
              return (
                <tr key={person.id}>
                  <td>
                    <div className="small strong" style={person.id === 0 ? { color: 'var(--danger)' } : undefined}>
                      {person.full_name}
                    </div>
                    {person.id !== 0 && (
                      <div className="tiny muted">
                        {person.employee_code} · {person.employment_type === '1099' ? '1099' : 'W-2'} ·{' '}
                        <span style={w2 && total > 40 ? { color: 'var(--warn)', fontWeight: 650 } : undefined}>{total}h</span>
                      </div>
                    )}
                  </td>
                  {days.map((d) => {
                    const cell = list.filter((s) => new Date(s.starts_at).toDateString() === d.toDateString());
                    return (
                      <td key={d.toISOString()} style={{ verticalAlign: 'top', minWidth: 112 }}>
                        <div className="stack-sm" style={{ gap: 4 }}>
                          {cell.map((s) => (
                            <button key={s.id} type="button" className="roster-shift" data-open={!s.user_id} onClick={() => onOpen(s)}>
                              <span className="tiny strong nowrap">{fmtRange(s.starts_at, s.ends_at)}</span>
                              <span className="tiny truncate">{s.post_code || s.post_name}</span>
                              {s.status === 'in_progress' && <span className="tiny" style={{ color: 'var(--ok)' }}>On post</span>}
                              {s.status === 'missed' && <span className="tiny" style={{ color: 'var(--danger)' }}>No show</span>}
                            </button>
                          ))}
                          {person.id !== 0 && (
                            <button
                              type="button"
                              className="roster-add"
                              onClick={() => onAdd(person, d)}
                              aria-label={`Add a shift for ${person.full_name} on ${fmtDay(d)}`}
                            >
                              +
                            </button>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td className="num nowrap">
                    <span className="strong">{total}h</span>
                    {w2 && total > 40 && (
                      <div>
                        <Chip kind="warn">+{Math.round((total - 40) * 10) / 10}h OT</Chip>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdminSchedulePage() {
  const toast = useToast();
  const [shifts, setShifts] = useState(null);
  const [posts, setPosts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [bulk, setBulk] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [siteFilter, setSiteFilter] = useState('');
  const [view, setView] = useState('officer');
  const [showAll, setShowAll] = useState(false);
  const [copying, setCopying] = useState(false);

  const range = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + weekOffset * 7);
    const end = new Date(start.getTime() + 7 * 86400000);
    return { start, end };
  }, [weekOffset]);

  const load = async () => {
    try {
      const [s, ref, emp] = await Promise.all([
        api.get(`/admin/shifts?from=${range.start.toISOString()}&to=${range.end.toISOString()}`),
        api.get('/admin/sites'),
        api.get('/admin/employees'),
      ]);
      setShifts(s.shifts);
      setPosts(ref.posts);
      setEmployees(emp.employees);
    } catch (err) {
      toast.error(err.message);
      setShifts([]);
    }
  };
  useEffect(() => {
    load();
  }, [weekOffset]);

  const days = useMemo(() => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(range.start.getTime() + i * 86400000);
      const list = (shifts || []).filter(
        (s) =>
          new Date(s.starts_at).toDateString() === day.toDateString() &&
          (!siteFilter || String(s.site_id) === siteFilter)
      );
      out.push({ day, list });
    }
    return out;
  }, [shifts, range, siteFilter]);

  const sites = useMemo(() => {
    const map = new Map();
    posts.forEach((p) => map.set(p.site_id, p.site_name));
    return [...map.entries()];
  }, [posts]);

  const totals = useMemo(() => {
    const list = (shifts || []).filter((s) => !siteFilter || String(s.site_id) === siteFilter);
    const scheduled = list.reduce(
      (sum, s) => sum + (new Date(s.ends_at) - new Date(s.starts_at)) / 3600000,
      0
    );
    return {
      count: list.length,
      unfilled: list.filter((s) => !s.user_id).length,
      hours: Math.round(scheduled * 10) / 10,
    };
  }, [shifts, siteFilter]);

  if (!shifts) return <LoadingPage label="Loading schedule" />;

  return (
    <div className="page page-wide stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Workforce</div>
          <h1>Schedule</h1>
        </div>
        <div className="row wrap">
          <button className="btn btn-ghost" onClick={() => setCopying(true)}>
            <Icon name="copy" size={16} /> Copy week
          </button>
          <button className="btn btn-ghost" onClick={() => window.print()}>
            <Icon name="print" size={16} /> Print
          </button>
          <button className="btn btn-ghost" onClick={() => setBulk(true)}>
            <Icon name="calendar" size={16} /> Recurring roster
          </button>
          <button className="btn btn-primary" onClick={() => setDialog({ shift: null })}>
            <Icon name="plus" size={16} /> Add shift
          </button>
        </div>
      </div>

      <div className="row-between wrap">
        <div className="row">
          <button className="btn btn-ghost btn-sm" aria-label="Previous week" onClick={() => setWeekOffset((w) => w - 1)}>
            <Icon name="back" size={15} />
          </button>
          <span className="strong small nowrap">
            {fmtDate(range.start)} - {fmtDate(new Date(range.end.getTime() - 86400000))}
          </span>
          <button className="btn btn-ghost btn-sm" aria-label="Next week" onClick={() => setWeekOffset((w) => w + 1)}>
            <Icon name="chevron" size={15} />
          </button>
          {weekOffset !== 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setWeekOffset(0)}>
              This week
            </button>
          )}
        </div>
        <div className="row wrap">
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'officer', label: 'By officer' },
              { value: 'day', label: 'By day' },
            ]}
          />
          {view === 'officer' && (
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} style={{ width: 'auto' }} />
              Everyone
            </label>
          )}
          <select
            aria-label="Filter by site"
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="">All sites</option>
            {sites.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <span className="small muted nowrap">
            {totals.count} shifts &middot; {totals.hours}h
            {totals.unfilled > 0 && <span style={{ color: 'var(--danger)' }}> &middot; {totals.unfilled} open</span>}
          </span>
        </div>
      </div>

      {view === 'officer' && (
        <RosterGrid
          shifts={shifts}
          employees={employees}
          range={range}
          siteFilter={siteFilter}
          showAll={showAll}
          onOpen={(s) => setDialog({ shift: s })}
          onAdd={(person, day) => {
            const start = new Date(day);
            start.setHours(8, 0, 0, 0);
            const end = new Date(day);
            end.setHours(16, 0, 0, 0);
            setDialog({ shift: { user_id: person.id, starts_at: start, ends_at: end } });
          }}
        />
      )}

      {view === 'day' && (
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {days.map(({ day, list }) => {
          const isToday = day.toDateString() === new Date().toDateString();
          return (
            <div key={day.toISOString()} className="card" style={isToday ? { borderColor: 'var(--brand-400)' } : undefined}>
              <div className="card-head" style={{ padding: '10px 12px' }}>
                <div>
                  <div className="strong small">{fmtDay(day)}</div>
                  <div className="tiny muted">{day.toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                </div>
                {list.length > 0 && <Chip>{list.length}</Chip>}
              </div>
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 70 }}>
                {list.length === 0 && <div className="tiny muted center" style={{ padding: 12 }}>No shifts</div>}
                {list.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setDialog({ shift: s })}
                    style={{
                      textAlign: 'left', font: 'inherit', cursor: 'pointer',
                      border: '1px solid var(--line)', borderLeft: `3px solid ${s.user_id ? 'var(--navy-600)' : 'var(--danger)'}`,
                      borderRadius: 8, padding: '7px 9px', background: 'var(--surface)',
                    }}
                  >
                    <div className="tiny strong nowrap">{fmtRange(s.starts_at, s.ends_at)}</div>
                    <div className="tiny truncate">{s.officer || 'Unassigned'}</div>
                    <div className="tiny muted truncate">{s.post_name}</div>
                    <div className="row wrap" style={{ gap: 4, marginTop: 3 }}>
                      {s.late_minutes > 0 && <Chip kind="warn">{s.late_minutes}m late</Chip>}
                      {s.clock_out_at && <Chip kind="ok">{toHours(s.minutes_worked)}h</Chip>}
                      {!s.clock_in_at && s.status === 'missed' && <Chip kind="danger">No show</Chip>}
                      {s.status === 'in_progress' && <Chip kind="brand" dot>On post</Chip>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {copying && (
        <CopyWeekDialog
          weekStart={range.start}
          siteFilter={siteFilter}
          siteName={sites.find(([id]) => String(id) === siteFilter)?.[1]}
          onClose={() => setCopying(false)}
          onSaved={load}
        />
      )}

      {dialog && (
        <ShiftDialog
          shift={dialog.shift}
          posts={posts}
          employees={employees}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            load();
          }}
        />
      )}
      {bulk && <BulkDialog posts={posts} employees={employees} onClose={() => setBulk(false)} onSaved={load} />}
    </div>
  );
}
