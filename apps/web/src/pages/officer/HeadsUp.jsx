import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDay, fmtTime } from '../../lib/format.js';
import { Banner, Field, Icon, Modal, Segmented, useToast } from '../../components/ui.jsx';

const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`);
/** How late, in minutes past the start, or in minutes from now once it has started. */
const LATE_BY = [10, 15, 20, 30, 45, 60];
/** The card is a full card this close to the start; before that, a line on it. */
const SOON_MINUTES = 120;

function RunningLateDialog({ data, onClose, onDone }) {
  const toast = useToast();
  const { shift } = data;
  const [by, setBy] = useState(15);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Before the start, "15" means fifteen minutes after it; once started, fifteen from now.
  const etaMinutes = shift.started ? by : Math.max(5, shift.minutes_to_start + by);
  const eta = new Date(Date.now() + etaMinutes * 60000);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/heads-up/${shift.id}/running-late`, { etaMinutes, note: note.trim() || undefined });
      toast.success('Your supervisors know you are on your way.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Running late"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Sending...' : 'Tell my supervisors'}</button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          {shift.post_name}, {shift.site_name}, {shift.started ? 'started' : 'starts'} {fmtTime(shift.starts_at)}. You can say this once; if it changes
          again, call your supervisor.
        </p>
        <div className="small strong">{shift.started ? 'I will be there in (minutes)' : 'How many minutes late?'}</div>
        <Segmented
          label={shift.started ? 'I will be there in (minutes)' : 'How many minutes late?'}
          value={by}
          onChange={setBy}
          options={LATE_BY.map((m) => ({ value: m, label: String(m) }))}
        />
        <div className="small">
          You expect to arrive by <strong>{fmtTime(eta)}</strong>.
        </div>
        <Field label="Anything they should know" hint="Optional. Up to 200 characters.">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Stuck in traffic on I-95" />
        </Field>
      </div>
    </Modal>
  );
}

function CallOffDialog({ data, onClose, onDone }) {
  const toast = useToast();
  const { shift, reasons } = data;
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = reason && (reason !== 'other' || note.trim().length >= 5);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/heads-up/${shift.id}/call-off`, { reason, note: note.trim() || undefined });
      toast.success('Called off. Your supervisors have been told and the shift is open.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Can't make it"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Keep my shift</button>
          <button className="btn btn-danger" onClick={save} disabled={busy || !ready}>{busy ? 'Sending...' : 'Call off this shift'}</button>
        </>
      }
    >
      <div className="stack">
        <Banner kind="warn" title={`${shift.post_name}, ${fmtDay(shift.starts_at)} ${fmtTime(shift.starts_at)}`}>
          The shift is taken off you and opened for other officers, and your supervisors are texted now so they can find cover. For a day
          or more off, request time off instead.
        </Banner>
        <fieldset className="check-row plain">
          <legend className="small strong">Why can't you come?</legend>
          <div className="stack-sm">
            {reasons.map((r) => (
              <label key={r.value} className="check">
                <input type="radio" name="call-off-reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="A few words for your supervisor" hint={reason === 'other' ? 'Required for something else.' : 'Optional.'}>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * On the officer's home screen before their next shift: tell the supervisors
 * they are running late, or that they cannot come at all, before it becomes a
 * no-show.
 */
export function HeadsUpCard({ onDuty }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => {
    api.get('/heads-up').then(setData, () => setData(null));
  }, []);
  useEffect(() => {
    if (onDuty) return undefined;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, onDuty]);
  if (onDuty || !data?.shift) return null;
  const { shift, notice } = data;
  const soon = shift.started || shift.minutes_to_start <= SOON_MINUTES || notice;
  const when = shift.started
    ? `Started ${fmtTime(shift.starts_at)}, and you have not clocked in.`
    : `${fmtDay(shift.starts_at)} at ${fmtTime(shift.starts_at)}, in ${mins(shift.minutes_to_start)}.`;
  const done = () => {
    setOpen(null);
    load();
  };
  return (
    <>
      {soon ? (
        <div className="card" id="heads-up">
          <div className="card-head">
            <h3>
              <Icon name="clock" size={18} /> {shift.started ? 'Your shift has started' : 'Your next shift'}
            </h3>
          </div>
          <div className="card-body stack-sm">
            <div>
              <div className="strong">{shift.post_name}</div>
              <div className="small muted">{shift.site_name}. {when}</div>
            </div>
            {notice ? (
              <div className="banner banner-info">
                <Icon name="check" size={18} />
                <div className="grow">
                  <strong>Your supervisors know you are running late</strong>
                  <div className="small">You said you would be there by {fmtTime(notice.eta_at)}{notice.note ? `: "${notice.note}"` : '.'}</div>
                </div>
              </div>
            ) : (
              <div className="small muted">Running late or can't make it? Tell your supervisors now, before it is a no-show.</div>
            )}
            <div className="row wrap" style={{ gap: 8 }}>
              {!notice && (
                <button className="btn btn-primary btn-sm" onClick={() => setOpen('late')}>
                  <Icon name="clock" size={15} /> Running late
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen('off')}>
                Can't make it
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="card card-pad row-between wrap" id="heads-up" style={{ gap: 8 }}>
          <span className="small muted">
            Can't make your {fmtTime(shift.starts_at)} shift at {shift.post_name}?
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen('off')}>
            Call off
          </button>
        </div>
      )}
      {open === 'late' && <RunningLateDialog data={data} onClose={() => setOpen(null)} onDone={done} />}
      {open === 'off' && <CallOffDialog data={data} onClose={() => setOpen(null)} onDone={done} />}
    </>
  );
}
