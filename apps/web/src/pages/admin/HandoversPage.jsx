import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtTime, toDateInput } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, Stat, useToast } from '../../components/ui.jsx';

const STATE_KIND = { late: 'danger', open: 'danger', unconfirmed: 'warn', confirmed: 'info', relieved: 'ok', closes: '' };
const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const mins = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`);
const tel = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

/** Monday of the week a shift falls in, for opening the schedule there. */
function weekOf(iso) {
  const d = new Date(iso);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateInput(d);
}

/** Push the relief, with a line of your own if you want; the officer on post is asked to stay. */
function ChaseDialog({ h, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/handovers/${h.shift_id}/chase`, { note: note.trim() || undefined });
      toast.success(h.state === 'late' ? `${h.relief.officer} was chased, and ${h.officer} asked to stay on post.` : `${h.relief.officer} was reminded.`);
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Chase ${h.relief.officer}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Sending...' : 'Send'}</button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          A notification goes to {h.relief.officer}'s phone{h.state === 'late' ? `, and ${h.officer} is asked to stay on ${h.post_name} until relieved. Time they are held over is paid` : ''}.
          If they do not answer, call them.
        </p>
        <Field label="Message" hint={`Optional. Without one they are told ${h.officer} is waiting to hand over.`}>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}

function Handover({ h, focused, onChase }) {
  const r = h.relief;
  const when = h.held_over_minutes > 0
    ? `Shift ended ${fmtTime(h.ends_at)} · ${h.state === 'relieved' ? 'handing over' : `held over ${mins(h.held_over_minutes)}`}`
    : `Shift ends ${fmtTime(h.ends_at)} · in ${mins(h.minutes_to_end)}`;
  return (
    <li className={`list-item handover${focused ? ' is-focused' : ''}`} id={`handover-${h.shift_id}`} style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="grow stack-sm">
        <div className="row wrap" style={{ gap: 8 }}>
          <Chip kind={STATE_KIND[h.state]} dot={h.severity === 'critical'}>{h.state_label}</Chip>
          <strong className="small">{h.post_name}</strong>
          <span className="tiny muted">{h.site_name}</span>
        </div>
        <div className="handover-pair small">
          <div>
            <div className="tiny muted">On post</div>
            <Link className="strong" to={`/admin/employees/${h.user_id}`}>{h.officer}</Link>
            <div className="tiny muted">{when}</div>
          </div>
          <Icon name="route" size={16} />
          <div>
            <div className="tiny muted">Relief</div>
            {!r ? (
              <div className="muted">Nobody: the post closes</div>
            ) : !r.user_id ? (
              <div className="strong" style={{ color: 'var(--danger)' }}>Nobody assigned</div>
            ) : (
              <>
                <Link className="strong" to={`/admin/employees/${r.user_id}`}>{r.officer}</Link>
                <div className="tiny muted">
                  {r.clocked_in_at
                    ? `On post since ${fmtTime(r.clocked_in_at)}`
                    : `Due ${fmtTime(r.starts_at)}${r.minutes_late ? ` · ${mins(r.minutes_late)} late` : ''} · ${r.confirmed ? 'confirmed' : 'not confirmed'}`}
                  {r.chased_at && !r.clocked_in_at ? ` · chased ${fmtTime(r.chased_at)}` : ''}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="row wrap handover-actions" style={{ gap: 6, justifyContent: 'flex-end' }}>
        {r?.user_id && !r.clocked_in_at && ['late', 'unconfirmed', 'confirmed'].includes(h.state) && (
          <button className={`btn btn-sm ${h.state === 'late' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onChase(h)} aria-label={`Chase ${r.officer}`}>
            <Icon name="megaphone" size={14} /> Chase
          </button>
        )}
        {r?.user_id && r.phone && !r.clocked_in_at && (
          <a className="btn btn-ghost btn-sm" href={tel(r.phone)} aria-label={`Call ${r.officer}`}>
            <Icon name="phone" size={14} /> Call relief
          </a>
        )}
        {r && !r.user_id && (
          <Link className="btn btn-primary btn-sm" to={`/admin/schedule?week=${weekOf(r.starts_at)}&shift=${r.shift_id}`} aria-label={`Find cover for ${h.post_name}`}>
            Find cover
          </Link>
        )}
        {h.phone && ['late', 'open'].includes(h.state) && (
          <a className="btn btn-ghost btn-sm" href={tel(h.phone)} aria-label={`Call ${h.officer}`}>
            <Icon name="phone" size={14} /> Call officer
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * Every post changing hands soon: who is on, who relieves them, and whether
 * that relief is on the way. An officer whose relief has not come stays on
 * post, held over and paid, until they do.
 */
export default function HandoversPage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const focus = Number(params.get('shift')) || null;
  const [windowMinutes, setWindowMinutes] = useState(120);
  const [data, setData] = useState(null);
  const [chasing, setChasing] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/handovers?window=${windowMinutes}`));
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast, windowMinutes]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (data && focus) document.getElementById(`handover-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [data, focus]);

  const c = data?.counts;
  return (
    <div className="page stack">
      <div className="page-head row-between wrap" style={{ marginBottom: 0, gap: 12 }}>
        <div>
          <div className="eyebrow">Operations</div>
          <h1>Handovers</h1>
          <p className="lead">
            Every officer on duty whose shift ends soon, and the officer due to relieve them. Nobody leaves a post uncovered: an officer whose
            relief is late stays on, held over and paid, and the board says who to chase.
          </p>
        </div>
        <Segmented
          label="Look ahead"
          value={windowMinutes}
          onChange={setWindowMinutes}
          options={[
            { value: 120, label: '2 hours' },
            { value: 240, label: '4 hours' },
            { value: 480, label: '8 hours' },
          ]}
        />
      </div>

      {!data ? (
        <LoadingPage label="Loading handovers" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Held over" value={c.held_over} foot="Past the end of their shift, waiting" alert={c.held_over > 0} />
            <Stat label="Relief late" value={c.late} foot="Due on post and not clocked in" alert={c.late > 0} />
            <Stat label="No relief assigned" value={c.open} foot="Find cover for the next shift" alert={c.open > 0} />
            <Stat label="Not confirmed" value={c.unconfirmed} foot={`Of ${s(c.total, 'handover')} in the next ${mins(data.window_minutes)}`} />
          </div>
          {c.held_over > 0 && (
            <Banner kind="danger" title={`${s(c.held_over, 'officer')} held over at the end of their shift`}>
              Chase the relief, or find cover. The held-over time is on their timesheet; if the relief never comes, the clock stops after eight
              hours.
            </Banner>
          )}
          <section className="card" aria-labelledby="handover-list">
            <div className="card-head">
              <h2 id="handover-list" className="section-title" style={{ margin: 0 }}>Next {mins(data.window_minutes)}</h2>
              <span className="small muted">{s(c.total, 'handover')}</span>
            </div>
            {data.handovers.length === 0 ? (
              <Empty icon="route" title="No posts change hands in this window">Nobody on duty has a shift ending in the next {mins(data.window_minutes)}.</Empty>
            ) : (
              <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.handovers.map((h) => (
                  <Handover key={h.shift_id} h={h} focused={h.shift_id === focus} onChase={setChasing} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {chasing && <ChaseDialog h={chasing} onClose={() => setChasing(null)} onDone={() => { setChasing(null); load(); }} />}
    </div>
  );
}
