import { useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/format.js';
import { Chip, Field, useToast } from '../../components/ui.jsx';

const STATE_KIND = { open: 'warn', filled: 'ok', covered: 'navy', withdrawn: '', expired: 'danger' };

/** What one officer said, as a chip. */
export function AnswerChip({ answer }) {
  if (answer === 'yes') return <Chip kind="ok">Said yes</Chip>;
  if (answer === 'no') return <Chip kind="danger">Said no</Chip>;
  return <Chip kind="info">Asked</Chip>;
}

/**
 * The offer on an open shift: who was asked and what each said, and the
 * controls for asking the officers ticked in the suggestions. Asking more on
 * an open offer adds to it. An offer is for the shift as saved.
 */
export function OfferPanel({ shift, offer, asking, dirty, canOffer, onClear, onChanged }) {
  const toast = useToast();
  const [firstYes, setFirstYes] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const open = offer?.state === 'open';
  if (!offer && !canOffer) return null;

  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post('/shift-offers', { shiftId: shift.id, userIds: asking, firstYes, note: note.trim() || undefined });
      const warn = r.warnings?.length ? ` Note: ${r.warnings.map((w) => `${w.name}: ${w.message}`).join(' ')}` : '';
      toast.success(`Asked ${r.asked} officer${r.asked === 1 ? '' : 's'}. Their answers show here and in the alerts.${warn}`);
      setNote('');
      onClear();
      onChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api.post(`/shift-offers/${offer.id}/withdraw`, {});
      toast.success('Offer withdrawn. Anyone still to answer has been told.');
      onChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" id="shift-offer">
      <div className="card-head" style={{ padding: '10px 14px' }}>
        <h3 style={{ fontSize: '0.88rem' }}>Offer this shift</h3>
        {offer && <Chip kind={STATE_KIND[offer.state]}>{offer.state === 'filled' || offer.state === 'covered' ? `${offer.state === 'filled' ? 'Taken' : 'Covered'} by ${offer.taken_by}` : offer.state_label}</Chip>}
      </div>
      <div className="card-pad stack-sm" style={{ paddingTop: 0 }}>
        {offer ? (
          <>
            <div className="tiny muted">
              Sent {fmtRelative(offer.created_at)}{offer.offered_by_name ? ` by ${offer.offered_by_name}` : ''} to {offer.counts.asked} officer{offer.counts.asked === 1 ? '' : 's'}:{' '}
              {offer.counts.yes} yes, {offer.counts.no} no, {offer.counts.waiting} not answered.{' '}
              {offer.first_yes ? 'The first yes gets the shift.' : 'Each yes comes to the request queue for you to approve.'}
              {offer.note && ` Note: "${offer.note}"`}
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {offer.recipients.map((r) => (
                <span key={r.user_id} className="row" style={{ gap: 4 }}>
                  <span className="small">{r.name}</span>
                  <AnswerChip answer={r.answer} />
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="tiny muted">
            Tick officers in the suggestions to ask them all at once. Each gets a notification and answers yes or no in the app.
          </div>
        )}
        {canOffer && asking.length > 0 && (
          <div className="stack-sm">
            {!open && (
              <label className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={firstYes} onChange={(e) => setFirstYes(e.target.checked)} />
                Give it to the first who says yes
              </label>
            )}
            <Field label="Note to them" hint="Optional. Up to 300 characters.">
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Called off sick. Overtime is approved for this one." />
            </Field>
            <div className="row wrap" style={{ gap: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={busy || dirty}>
                {busy ? 'Sending...' : `Ask ${asking.length} officer${asking.length === 1 ? '' : 's'}`}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClear} disabled={busy}>
                Clear
              </button>
            </div>
            {dirty && <div className="tiny" style={{ color: 'var(--danger)' }}>Save your changes to the shift first: an offer is for the shift as saved.</div>}
          </div>
        )}
        {open && (
          <div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={withdraw} disabled={busy}>
              Withdraw offer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
