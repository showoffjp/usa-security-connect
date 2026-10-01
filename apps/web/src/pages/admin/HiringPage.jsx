import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime, fmtRelative } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, useToast } from '../../components/ui.jsx';
import {
  APPLICANT_SOURCE_LABEL, APPLICANT_SOURCES, HIRING_CHECKS, HIRING_STAGE_LABEL, LICENCE_CLASSES, LICENCE_CLASS_LABEL, OPEN_HIRING_STAGES,
} from '@shared/domain.js';

const NEXT = { applied: 'screening', screening: 'interview', interview: 'offer' };

/** The starting code and PIN, shown once, the way a new login is everywhere else. */
function Credentials({ credentials, name, onClose }) {
  return (
    <Modal
      title={`${name} is hired`}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="stack">
        <Banner kind="warn" title="Shown once">
          {credentials.note}
        </Banner>
        <dl className="kv">
          <dt>Employee code</dt>
          <dd className="mono strong">{credentials.employeeCode}</dd>
          <dt>Starting PIN</dt>
          <dd className="mono strong">{credentials.pin}</dd>
        </dl>
        <p className="small muted" style={{ margin: 0 }}>They choose their own PIN the first time they sign in. Their record is under Employees.</p>
      </div>
    </Modal>
  );
}

function HireDialog({ applicant, sites, onClose, onHired }) {
  const toast = useToast();
  const [form, setForm] = useState({ employmentType: 'w2', payType: 'hourly', payRate: '', defaultSiteId: '', w9OnFile: false });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const d = await api.post(`/admin/hiring/${applicant.id}/hire`, {
        employmentType: form.employmentType,
        payType: form.payType,
        payRate: Number(form.payRate),
        defaultSiteId: form.defaultSiteId ? Number(form.defaultSiteId) : null,
        w9OnFile: form.w9OnFile,
      });
      toast.success(`${applicant.first_name} ${applicant.last_name} is now an employee.`);
      onHired(d);
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Hire ${applicant.first_name} ${applicant.last_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !(Number(form.payRate) > 0)}>
            {busy ? 'Hiring...' : 'Hire and create login'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Classification">
            <select value={form.employmentType} onChange={set('employmentType')}>
              <option value="w2">W-2 employee</option>
              <option value="1099">1099 contractor</option>
            </select>
          </Field>
          <Field label="Paid">
            <select value={form.payType} onChange={set('payType')}>
              <option value="hourly">Hourly</option>
              <option value="per_shift">Per shift</option>
              <option value="salary">Salary</option>
            </select>
          </Field>
          <Field label={form.payType === 'hourly' ? 'Rate per hour ($)' : form.payType === 'per_shift' ? 'Rate per shift ($)' : 'Rate ($)'} required>
            <input type="number" min="1" step="0.25" value={form.payRate} onChange={set('payRate')} />
          </Field>
          <Field label="Usual site">
            <select value={form.defaultSiteId} onChange={set('defaultSiteId')}>
              <option value="">None yet</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {form.employmentType === '1099' && (
          <label className="check">
            <input type="checkbox" checked={form.w9OnFile} onChange={set('w9OnFile')} />
            W-9 is on file
          </label>
        )}
      </div>
    </Modal>
  );
}

function ApplicantDialog({ id, sites, onClose, onChanged }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [hiring, setHiring] = useState(false);
  const [credentials, setCredentials] = useState(null);

  // Ticks still on their way to the server, laid over whatever it last said,
  // so a quick second tick is not undone by the answer to the first.
  const pending = useRef(new Map());
  const withPending = (d) =>
    d && { ...d, checks: d.checks.map((x) => (pending.current.has(x.key) ? { ...x, done: pending.current.get(x.key) } : x)) };

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/admin/hiring/${id}`);
      setData(withPending(d));
    } catch (err) {
      toast.error(err.message);
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, toast, onClose]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn) => {
    try {
      setData(withPending(await fn()));
      onChanged();
    } catch (err) {
      toast.error(err.message);
      load();
    }
  };
  const move = (stage, why) => act(() => api.patch(`/admin/hiring/${id}/stage`, { stage, reason: why || null }));
  const toggle = async (c) => {
    pending.current.set(c.key, !c.done);
    setData(withPending);
    try {
      const d = await api.put(`/admin/hiring/${id}/checks/${c.key}`, { done: !c.done });
      pending.current.delete(c.key);
      setData(withPending(d));
      onChanged();
    } catch (err) {
      pending.current.delete(c.key);
      toast.error(err.message);
      load();
    }
  };
  const addNote = async (e) => {
    e.preventDefault();
    await act(() => api.post(`/admin/hiring/${id}/notes`, { body: noteText }));
    setNoteText('');
  };

  if (!data) return <Modal title="Applicant" onClose={onClose}><LoadingPage /></Modal>;
  const a = data.applicant;
  const open = OPEN_HIRING_STAGES.includes(a.stage);

  return (
    <>
      <Modal
        title={`${a.first_name} ${a.last_name}`}
        wide
        onClose={onClose}
        footer={
          <>
            {open && (
              <button className="btn btn-ghost" onClick={() => setRejecting(true)}>
                Not taking on
              </button>
            )}
            {a.stage === 'rejected' && (
              <button className="btn btn-ghost" onClick={() => move('applied', 'Application reopened.')}>
                Reopen
              </button>
            )}
            {NEXT[a.stage] && (
              <button className="btn btn-primary" onClick={() => move(NEXT[a.stage])}>
                Move to {HIRING_STAGE_LABEL[NEXT[a.stage]].toLowerCase()}
              </button>
            )}
            {a.stage === 'offer' && isAdmin && (
              <button className="btn btn-primary" onClick={() => setHiring(true)} disabled={!a.ready_to_hire}>
                Hire
              </button>
            )}
          </>
        }
      >
        <div className="stack">
          <div className="row wrap" style={{ gap: 6 }}>
            <Chip kind={a.stage === 'hired' ? 'ok' : a.stage === 'rejected' ? '' : 'info'}>{HIRING_STAGE_LABEL[a.stage]}</Chip>
            <Chip>{LICENCE_CLASS_LABEL[a.licence_class]}</Chip>
            <Chip>{APPLICANT_SOURCE_LABEL[a.source] || a.source}</Chip>
            {a.hired_code && <Chip kind="ok">Employee {a.hired_code}</Chip>}
          </div>
          {a.stage === 'rejected' && a.rejected_reason && <Banner kind="info" title="Not taken on">{a.rejected_reason}</Banner>}
          {a.stage === 'offer' && !a.ready_to_hire && (
            <Banner kind="warn">The required checks have to be done before they can be hired.</Banner>
          )}
          <dl className="kv">
            <dt>Email</dt>
            <dd>
              <a href={`mailto:${a.email}`}>{a.email}</a>
            </dd>
            <dt>Phone</dt>
            <dd>
              <a href={`tel:${a.phone}`}>{a.phone}</a>
            </dd>
            {a.city && (
              <>
                <dt>City</dt>
                <dd>{a.city}</dd>
              </>
            )}
            {a.licence_number && (
              <>
                <dt>Licence</dt>
                <dd>
                  {a.licence_number}
                  {a.licence_expires_on ? `, expires ${fmtDate(a.licence_expires_on)}` : ''}
                </dd>
              </>
            )}
            {a.availability && (
              <>
                <dt>Available</dt>
                <dd>{a.availability}</dd>
              </>
            )}
            {a.referred_by && (
              <>
                <dt>Referred by</dt>
                <dd>{a.referred_by}</dd>
              </>
            )}
            <dt>Applied</dt>
            <dd>{fmtDateTime(a.created_at)}</dd>
          </dl>
          {a.experience && <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{a.experience}</p>}

          <fieldset className="visit-checks">
            <legend>Before they can start</legend>
            {data.checks.map((c) => (
              <label key={c.key} className="check">
                <input type="checkbox" checked={c.done} onChange={() => toggle(c)} disabled={!open} />
                <span>
                  {c.label}
                  {c.required && <span className="muted"> (required)</span>}
                  {c.done && c.done_by_name && <span className="tiny muted"> · {c.done_by_name}, {fmtRelative(c.done_at)}</span>}
                </span>
              </label>
            ))}
          </fieldset>

          <section aria-labelledby="applicant-notes-title">
            <h3 id="applicant-notes-title" className="small strong" style={{ margin: '0 0 6px' }}>
              Notes
            </h3>
            <form className="row" style={{ gap: 8, marginBottom: 8 }} onSubmit={addNote}>
              <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note" aria-label="Add a note" maxLength={2000} />
              <button className="btn btn-sm" type="submit" disabled={noteText.trim().length < 2}>
                Add
              </button>
            </form>
            {data.notes.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>No notes yet.</p>
            ) : (
              <ul className="applicant-notes">
                {data.notes.map((n) => (
                  <li key={n.id}>
                    <div className="small">{n.body}</div>
                    <div className="tiny muted">
                      {n.author_name || 'Website'}, {fmtDateTime(n.created_at)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Modal>

      {rejecting && (
        <Modal
          title="Not taking them on"
          onClose={() => setRejecting(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setRejecting(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                disabled={reason.trim().length < 5}
                onClick={async () => {
                  await move('rejected', reason);
                  setRejecting(false);
                  setReason('');
                }}
              >
                Close the application
              </button>
            </>
          }
        >
          <Field label="Why" required hint="Kept on their record; it is not sent to them.">
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </Modal>
      )}
      {hiring && (
        <HireDialog
          applicant={a}
          sites={sites}
          onClose={() => setHiring(false)}
          onHired={(d) => {
            setHiring(false);
            setData(d);
            setCredentials(d.credentials);
            onChanged();
          }}
        />
      )}
      {credentials && <Credentials credentials={credentials} name={`${a.first_name} ${a.last_name}`} onClose={() => setCredentials(null)} />}
    </>
  );
}

const blankApplicant = { firstName: '', lastName: '', email: '', phone: '', city: '', licenceClass: 'D', source: 'walk_in', referredBy: '', availability: '' };

function AddApplicant({ onClose, onAdded }) {
  const toast = useToast();
  const [form, setForm] = useState(blankApplicant);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const d = await api.post('/admin/hiring', {
        ...form,
        city: form.city || null,
        referredBy: form.referredBy || null,
        availability: form.availability || null,
      });
      toast.success('Applicant added.');
      onAdded(d.applicant.id);
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add an applicant"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Adding...' : 'Add applicant'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="First name" required error={errors.firstName}>
            <input value={form.firstName} onChange={set('firstName')} />
          </Field>
          <Field label="Last name" required error={errors.lastName}>
            <input value={form.lastName} onChange={set('lastName')} />
          </Field>
          <Field label="Email" required error={errors.email}>
            <input type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Phone" required error={errors.phone}>
            <input type="tel" value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="City">
            <input value={form.city} onChange={set('city')} />
          </Field>
          <Field label="Licence">
            <select value={form.licenceClass} onChange={set('licenceClass')}>
              {LICENCE_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {LICENCE_CLASS_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How they came to us">
            <select value={form.source} onChange={set('source')}>
              {APPLICANT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {APPLICANT_SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Referred by">
            <input value={form.referredBy} onChange={set('referredBy')} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function Card({ a, onOpen }) {
  return (
    <li>
      <button className="hiring-card" onClick={() => onOpen(a.id)}>
        <span className="strong small">
          {a.first_name} {a.last_name}
        </span>
        <span className="tiny muted">
          {LICENCE_CLASS_LABEL[a.licence_class]}
          {a.city ? ` · ${a.city}` : ''}
        </span>
        <span className="row wrap" style={{ gap: 4 }}>
          <Chip kind={a.ready_to_hire ? 'ok' : ''}>
            {a.checks_done} of {HIRING_CHECKS.length} checks
          </Chip>
          {a.days_in_stage >= 3 && OPEN_HIRING_STAGES.includes(a.stage) && <Chip kind="warn">{a.days_in_stage}d waiting</Chip>}
        </span>
      </button>
    </li>
  );
}

/** Applicants from the website and the office, stage by stage, to a hire. */
export default function HiringPage() {
  const toast = useToast();
  const [view, setView] = useState('board');
  const [data, setData] = useState(null);
  const [closed, setClosed] = useState(null);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [sites, setSites] = useState([]);
  const closeDialog = useCallback(() => setOpen(null), []);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/hiring'));
      if (view !== 'board') setClosed((await api.get(`/admin/hiring?stage=${view}`)).applicants);
    } catch (err) {
      toast.error(err.message);
      setData((d) => d || { applicants: [], counts: {} });
    }
  }, [view, toast]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api.get('/reference').then((r) => setSites(r.sites || []), () => {});
  }, []);

  if (!data) return <LoadingPage label="Loading applicants" />;
  const byStage = (stage) => data.applicants.filter((a) => a.stage === stage);

  return (
    <div className="page page-wide stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="eyebrow">Workforce</div>
          <h1>Hiring</h1>
          <p className="lead">
            Applications from the website at <a href="/apply">/apply</a> and the ones you add, through the checks to a login.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Add applicant
        </button>
      </div>

      <Segmented
        label="Hiring view"
        value={view}
        onChange={setView}
        options={[
          { value: 'board', label: 'In progress' },
          { value: 'hired', label: `Hired (${data.counts.hired || 0})` },
          { value: 'rejected', label: `Not taken on (${data.counts.rejected || 0})` },
        ]}
      />

      {view === 'board' ? (
        <div className="hiring-board">
          {OPEN_HIRING_STAGES.map((stage) => (
            <section key={stage} className="hiring-column" aria-labelledby={`stage-${stage}`}>
              <h2 id={`stage-${stage}`} className="small strong">
                {HIRING_STAGE_LABEL[stage]} <span className="muted">({byStage(stage).length})</span>
              </h2>
              {byStage(stage).length === 0 ? (
                <p className="tiny muted">Nobody here.</p>
              ) : (
                <ul className="hiring-cards">
                  {byStage(stage).map((a) => (
                    <Card key={a.id} a={a} onOpen={setOpen} />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="card">
          {!closed ? (
            <LoadingPage />
          ) : closed.length === 0 ? (
            <Empty icon="users" title="Nobody here yet" />
          ) : (
            <ul className="list">
              {closed.map((a) => (
                <li key={a.id} className="list-item" onClick={() => setOpen(a.id)}>
                  <div className="grow">
                    <div className="strong small">
                      {a.first_name} {a.last_name}
                    </div>
                    <div className="tiny muted">
                      {view === 'hired' ? `Employee ${a.hired_code || '--'}` : a.rejected_reason} · {fmtDate(a.stage_changed_at)}
                    </div>
                  </div>
                  <button className="btn btn-sm btn-ghost">Open</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {open && <ApplicantDialog id={open} sites={sites} onClose={closeDialog} onChanged={load} />}
      {adding && (
        <AddApplicant
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            load();
            setOpen(id);
          }}
        />
      )}
    </div>
  );
}
