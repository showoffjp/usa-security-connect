import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime } from '../../lib/format.js';
import { Banner, Chip, Field, Modal, useToast } from '../../components/ui.jsx';
import {
  CONDUCT_LEVELS, CONDUCT_LEVEL_LABEL, CONDUCT_ADMIN_LEVELS, CONDUCT_CATEGORIES, CONDUCT_CATEGORY_LABEL, CONDUCT_ACTIVE_MONTHS,
} from '@shared/domain.js';

export const LEVEL_KIND = { coaching: 'info', verbal_warning: 'warn', written_warning: 'warn', final_warning: 'danger', suspension: 'danger' };

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Where a record stands, in a chip. */
export function RecordState({ r }) {
  if (r.status === 'rescinded') return <Chip>Rescinded</Chip>;
  if (r.status === 'refused') return <Chip kind="danger">Refused to sign</Chip>;
  if (r.status === 'acknowledged') return <Chip kind="ok">Signed</Chip>;
  return <Chip kind={r.signature_overdue ? 'danger' : 'warn'}>{r.signature_overdue ? 'Not signed, overdue' : 'Waiting for signature'}</Chip>;
}

/**
 * Record a step on an officer's record. With `officer` the officer is fixed;
 * otherwise the active officers are offered. The step a new record would
 * usually be is suggested once the officer and the kind of problem are known.
 */
export function IssueDialog({ officer, initial = null, onClose, onDone }) {
  const toast = useToast();
  const { isAdmin, user } = useAuth();
  const [people, setPeople] = useState(null);
  const [userId, setUserId] = useState(officer ? String(officer.id) : '');
  const [standing, setStanding] = useState(null);
  const [category, setCategory] = useState(initial?.category || 'attendance');
  const [level, setLevel] = useState('coaching');
  const [touched, setTouched] = useState(false);
  const [occurredOn, setOccurredOn] = useState(ymd(new Date()));
  const [summary, setSummary] = useState(initial?.summary || '');
  const [expectations, setExpectations] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (officer) return;
    api.get('/admin/employees').then(
      (d) => setPeople((d.employees || []).filter((e) => e.status === 'active' && (e.role === 'officer' || (isAdmin && e.role === 'supervisor')) && e.id !== user?.id)),
      () => setPeople([])
    );
  }, [officer, isAdmin, user]);

  useEffect(() => {
    if (!userId) return setStanding(null);
    let alive = true;
    api.get(`/conduct/officers/${userId}`).then((d) => alive && setStanding(d.standing), () => alive && setStanding(null));
    return () => {
      alive = false;
    };
  }, [userId]);

  const allowed = CONDUCT_LEVELS.filter((l) => isAdmin || !CONDUCT_ADMIN_LEVELS.includes(l));
  const suggested = standing?.next?.[category] || 'coaching';
  // A supervisor whose officer's record points to a final warning can record
  // at most a written warning; an administrator decides on the rest.
  const offered = allowed.includes(suggested) ? suggested : allowed[allowed.length - 1];
  // Follow the suggestion until the supervisor picks a step themselves.
  useEffect(() => {
    if (!touched) setLevel(offered);
  }, [offered, touched]);
  const stepHint = !standing
    ? undefined
    : offered === suggested
      ? `Usually ${CONDUCT_LEVEL_LABEL[suggested].toLowerCase()}, from their record this year.`
      : `Their record this year points to a ${CONDUCT_LEVEL_LABEL[suggested].toLowerCase()}, which is an administrator's decision.`;
  const save = async () => {
    setBusy(true);
    try {
      const res = await api.post('/conduct', {
        userId: Number(userId), category, level, occurredOn, summary: summary.trim(), expectations: expectations.trim(),
        ...(level === 'suspension' ? { suspensionStartsOn: from, suspensionEndsOn: to } : {}),
      });
      const n = res.affected_shifts?.length || 0;
      toast.success(n ? `Recorded. They are rostered on ${n} shift${n === 1 ? '' : 's'} during the suspension: reassign ${n === 1 ? 'it' : 'them'} on the schedule.` : 'Recorded. They have been asked to read and sign it.');
      onDone(res);
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  const ready = userId && summary.trim().length >= 20 && expectations.trim().length >= 10 && (level !== 'suspension' || (from && to));

  return (
    <Modal
      title={officer ? `Record a step for ${officer.name}` : 'Record a step'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>
            {busy ? 'Recording...' : `Record ${CONDUCT_LEVEL_LABEL[level].toLowerCase()}`}
          </button>
        </>
      }
    >
      <div className="stack">
        {!officer && (
          <Field label="Officer" required>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{people ? 'Choose an officer' : 'Loading...'}</option>
              {(people || []).map((p) => (
                <option key={p.id} value={p.id}>{p.first_name} {p.last_name} (#{p.employee_code})</option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid grid-2">
          <Field label="What it is about" required>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CONDUCT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{CONDUCT_CATEGORY_LABEL[c]}</option>
              ))}
            </select>
          </Field>
          <Field label="Step" required hint={stepHint}>
            <select value={level} onChange={(e) => { setTouched(true); setLevel(e.target.value); }}>
              {allowed.map((l) => (
                <option key={l} value={l}>{CONDUCT_LEVEL_LABEL[l]}{l === suggested ? ' (suggested)' : ''}</option>
              ))}
            </select>
          </Field>
        </div>
        {standing?.level && (
          <div className="small muted">
            Their record now: <Chip kind={LEVEL_KIND[standing.level]}>{standing.level_label}</Chip> · {standing.active} record{standing.active === 1 ? '' : 's'} in the last {CONDUCT_ACTIVE_MONTHS} months
          </div>
        )}
        <Field label="When it happened" required>
          <input type="date" value={occurredOn} max={ymd(new Date())} onChange={(e) => setOccurredOn(e.target.value)} />
        </Field>
        {level === 'suspension' && (
          <div className="grid grid-2">
            <Field label="First day off" required>
              <input type="date" value={from} min={occurredOn} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Last day off" required hint="At most 30 days. They cannot be rostered on these days.">
              <input type="date" value={to} min={from || occurredOn} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="What happened" required hint="Dates, times and places, as you would want to read them in a year.">
          <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={3000} />
        </Field>
        <Field label="What is expected from now on" required>
          <textarea rows={2} value={expectations} onChange={(e) => setExpectations(e.target.value)} maxLength={2000} />
        </Field>
        <Banner kind="info" title="The officer reads and signs this">
          They are notified and asked to sign it in the app, and can add their side of it. Signing says they have read it, not that they agree.
        </Banner>
      </div>
    </Modal>
  );
}

/** Record that the officer will not sign, and who saw it. */
export function RefusedDialog({ r, onClose, onDone }) {
  const toast = useToast();
  const [witness, setWitness] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/conduct/${r.id}/refused`, { witness: witness.trim() });
      toast.success('Recorded as refused to sign.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${r.officer} will not sign`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || witness.trim().length < 3}>{busy ? 'Saving...' : 'Record refusal'}</button>
        </>
      }
    >
      <Field label="Witness" required hint="Who was there when they were shown it and declined to sign.">
        <input value={witness} onChange={(e) => setWitness(e.target.value)} maxLength={160} />
      </Field>
    </Modal>
  );
}

/** Take a record back: an administrator's decision, with the reason kept. */
export function RescindDialog({ r, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/conduct/${r.id}/rescind`, { reason: reason.trim() });
      toast.success('Rescinded. It stays on file, marked, and no longer counts.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Rescind ${r.officer}'s ${r.level_label.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={save} disabled={busy || reason.trim().length < 5}>{busy ? 'Rescinding...' : 'Rescind'}</button>
        </>
      }
    >
      <Field label="Why" required hint="Kept with the record.">
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
}

/** One record, in full, with what can still be done about it. */
export function RecordItem({ r, showOfficer = true, onRefused, onRescind, open = false }) {
  const { isAdmin } = useAuth();
  // The body is only rendered while the record is open, so a closed one has
  // no hidden buttons in it.
  const [expanded, setExpanded] = useState(open);
  return (
    <details className="list-item conduct-record" open={open} id={`record-${r.id}`} onToggle={(e) => setExpanded(e.currentTarget.open)}
      style={{ display: 'block', cursor: 'default', opacity: r.active ? 1 : 0.75 }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
        <div className="row-between wrap" style={{ gap: 8 }}>
          <div>
            <span className="small strong">{showOfficer ? `${r.officer} · ` : ''}{r.level_label}</span>{' '}
            <span className="tiny muted">{r.category_label} · {fmtDate(r.occurred_on)}{r.issued_by_name ? ` · by ${r.issued_by_name}` : ''}</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Chip kind={LEVEL_KIND[r.level]}>{r.level_label}</Chip>
            <RecordState r={r} />
          </div>
        </div>
      </summary>
      {expanded && <div className="stack-sm small" style={{ marginTop: 8 }}>
        {r.level === 'suspension' && r.suspension_starts_on && (
          <div><strong>Off work:</strong> {fmtDate(r.suspension_starts_on)}{r.suspension_ends_on !== r.suspension_starts_on ? ` to ${fmtDate(r.suspension_ends_on)}` : ''}</div>
        )}
        <div><strong>What happened:</strong> {r.summary}</div>
        <div><strong>Expected from now on:</strong> {r.expectations}</div>
        {r.status === 'acknowledged' && (
          <div className="muted">Signed "{r.signature}" {fmtDateTime(r.acknowledged_at)}.</div>
        )}
        {r.officer_statement && <div className="signoff-dispute"><strong>Their side:</strong> {r.officer_statement}</div>}
        {r.status === 'refused' && (
          <div className="muted">Refused to sign, {fmtDateTime(r.refused_at)}. Witness: {r.refused_witness}{r.refused_by_name ? `. Recorded by ${r.refused_by_name}` : ''}.</div>
        )}
        {r.status === 'rescinded' && (
          <div className="muted">Rescinded {fmtDateTime(r.rescinded_at)}{r.rescinded_by_name ? ` by ${r.rescinded_by_name}` : ''}: {r.rescind_reason}</div>
        )}
        {!r.active && r.status !== 'rescinded' && <div className="muted">More than {CONDUCT_ACTIVE_MONTHS} months ago: no longer counts.</div>}
        <div className="row wrap" style={{ gap: 8 }}>
          {r.status === 'issued' && onRefused && (
            <button className="btn btn-ghost btn-sm" onClick={() => onRefused(r)} aria-label={`Record that ${r.officer} refused to sign`}>Record refusal to sign</button>
          )}
          {isAdmin && r.status !== 'rescinded' && onRescind && (
            <button className="btn btn-ghost btn-sm" onClick={() => onRescind(r)} aria-label={`Rescind ${r.officer}'s ${r.level_label.toLowerCase()}`}>Rescind</button>
          )}
        </div>
      </div>}
    </details>
  );
}
