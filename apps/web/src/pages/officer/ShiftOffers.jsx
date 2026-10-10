import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDay, fmtRange } from '../../lib/format.js';
import { Chip, Icon, useToast } from '../../components/ui.jsx';

/** Where an offer stands for the officer asked, in a line. */
function outcome(o) {
  if (o.state === 'filled' && o.mine) return { kind: 'ok', text: 'It is yours: on your schedule, and confirmed.' };
  if (o.state === 'filled' || o.state === 'covered') return { kind: '', text: 'It went to somebody else. Thank you for saying yes.' };
  if (o.state === 'withdrawn') return { kind: '', text: 'The supervisor no longer needs it covered.' };
  if (o.state === 'expired') return { kind: '', text: 'The shift has started.' };
  if (o.answer === 'yes') return { kind: 'info', text: 'You said yes. A supervisor will confirm who gets it.' };
  if (o.answer === 'no') return { kind: '', text: 'You said no.' };
  return null;
}

function OfferRow({ o, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const say = async (answer) => {
    setBusy(true);
    try {
      const r = await api.post(`/shift-offers/${o.id}/answer`, { answer });
      toast.success(
        r.result === 'assigned'
          ? 'The shift is yours. It is on your schedule.'
          : r.result === 'claimed'
            ? 'Thanks. A supervisor will confirm who gets it.'
            : 'Thanks for letting us know.'
      );
      onDone();
    } catch (err) {
      toast.error(err.message);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  const said = outcome(o);
  const open = o.state === 'open';
  return (
    <div className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="lead-icon" style={{ background: 'var(--brand-100)', color: 'var(--brand-text)' }}>
        <Icon name="calendar" size={17} />
      </div>
      <div className="grow stack-sm" style={{ gap: 4 }}>
        <div className="small strong">
          {o.post_name}, {o.site_name}
        </div>
        <div className="small">
          {fmtDay(o.starts_at)}, {fmtRange(o.starts_at, o.ends_at)}
          {o.armed && <span className="muted"> · armed post</span>}
        </div>
        {o.note && <div className="tiny muted">"{o.note}"{o.offered_by_name ? ` - ${o.offered_by_name}` : ''}</div>}
        {open && !o.answer && (
          <div className="tiny muted">
            {o.asked > 1 ? `Asked of ${o.asked} officers. ` : ''}
            {o.first_yes ? 'The first to say yes gets it.' : 'A supervisor will choose from those who say yes.'}
          </div>
        )}
        {said && (
          <div className={`small strong${said.kind ? '' : ' muted'}`} style={said.kind ? { color: `var(--${said.kind})` } : undefined}>
            {said.text}
          </div>
        )}
        {open && o.refusal && <div className="tiny" style={{ color: 'var(--danger)' }}>You cannot take it: {o.refusal}</div>}
        {open && o.answer !== 'yes' && (
          <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
            {o.can_say_yes && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => say('yes')} disabled={busy} aria-label={`Yes, I can cover ${o.post_name}`}>
                <Icon name="check" size={14} /> {o.answer === 'no' ? 'Yes after all' : 'Yes, I can'}
              </button>
            )}
            {!o.answer && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => say('no')} disabled={busy} aria-label={`No, I cannot cover ${o.post_name}`}>
                No
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Can you cover?": open shifts a supervisor has asked this officer about,
 * answered with a tap, and how the ones they said yes to turned out.
 */
export function ShiftOffersCard() {
  const [offers, setOffers] = useState(null);
  const load = useCallback(() => {
    api.get('/shift-offers/mine').then(
      (d) => setOffers(d.offers),
      () => setOffers([])
    );
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (!offers?.length) return null;
  const waiting = offers.filter((o) => o.state === 'open' && !o.answer).length;
  return (
    <div className="card" id="shift-offers">
      <div className="card-head">
        <h3>Can you cover?</h3>
        {waiting > 0 && <Chip kind="warn">{waiting} to answer</Chip>}
      </div>
      <div className="list">
        {offers.map((o) => (
          <OfferRow key={o.id} o={o} onDone={load} />
        ))}
      </div>
    </div>
  );
}
