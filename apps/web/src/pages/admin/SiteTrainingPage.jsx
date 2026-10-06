import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDay, fmtRange, toDateInput } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Stat, useToast } from '../../components/ui.jsx';
import { TRAINING_METHODS, TRAINING_METHOD_LABEL, QUALIFICATION_LAPSE_DAYS } from '@shared/domain.js';

const STATE_CHIP = {
  trained: ['ok', 'Trained'],
  lapsed: ['warn', 'Needs a refresher'],
  revoked: ['danger', 'Withdrawn'],
  untrained: ['', 'Not trained'],
};
const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Monday of the week a shift falls in, for opening the schedule there. */
function weekOf(iso) {
  const d = new Date(iso);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateInput(d);
}

/**
 * Sign an officer off at a post. With `person` the officer is already
 * chosen; otherwise everyone not trained there is offered, those who know the
 * post best first.
 */
function SignOffDialog({ post, person, onClose, onDone }) {
  const toast = useToast();
  const [people, setPeople] = useState(null);
  const [userId, setUserId] = useState(person ? String(person.user_id) : '');
  const [method, setMethod] = useState(person?.shifts ? 'shadow_shift' : 'walkthrough');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (person) return;
    api
      .get(`/site-training/posts/${post.id}`)
      .then((d) => setPeople(d.people.filter((p) => p.state !== 'trained')))
      .catch((err) => toast.error(err.message));
  }, [post.id, person, toast]);

  const needsNote = method === 'shadow_shift' && !note.trim();
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/site-training', { postId: post.id, userId: Number(userId), method, note: note.trim() || undefined });
      toast.success('Signed off. They can now work this post alone.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Sign off at ${post.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !userId || needsNote}>
            {busy ? 'Signing off...' : 'Sign off'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          {post.site_name}. Once signed off, the officer can claim and swap into shifts here, and is no longer flagged on the roster.
        </p>
        {person ? (
          <div className="small">
            <strong>{person.officer}</strong>
            {person.shifts ? <span className="muted"> · worked {s(person.shifts, 'shift')} here</span> : null}
          </div>
        ) : !people ? (
          <div className="small muted">Loading officers...</div>
        ) : (
          <Field label="Officer" required>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose an officer</option>
              {people.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name} (#{p.employee_code}){p.shifts_here ? ` - ${s(p.shifts_here, 'shift')} here` : ''}
                  {p.state === 'lapsed' ? ' - needs a refresher' : p.state === 'revoked' ? ' - withdrawn' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="How they learned the post" required>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {TRAINING_METHODS.map((m) => (
              <option key={m} value={m}>{TRAINING_METHOD_LABEL[m]}</option>
            ))}
          </select>
        </Field>
        <Field
          label={method === 'shadow_shift' ? 'Who they shadowed, and when' : 'Note'}
          required={method === 'shadow_shift'}
          hint="Kept on their record with your name and today's date."
        >
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  );
}

/** Withdraw an officer's training at a post, with the reason for their record. */
function RevokeDialog({ q, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/site-training/${q.id}/revoke`, { reason: reason.trim() });
      const n = res.upcoming.length;
      toast.success(n ? `Withdrawn. ${q.officer} has ${s(n, 'shift')} here in the next two weeks: give them a trained partner or find cover.` : 'Withdrawn.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Withdraw ${q.officer}'s training`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={save} disabled={busy || reason.trim().length < 5}>
            {busy ? 'Withdrawing...' : 'Withdraw'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          {q.post_name}, {q.site_name}. They will not be able to claim or swap into shifts here, and any they are rostered on are flagged until
          they are signed off again.
        </p>
        <Field label="Why" required hint="The officer sees this on their profile.">
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  );
}

function Person({ name, userId, children, action }) {
  return (
    <div className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="grow">
        <Link className="small strong" to={`/admin/employees/${userId}`}>{name}</Link>
        <div className="tiny muted">{children}</div>
      </div>
      {action}
    </div>
  );
}

function PostCard({ post, onSignOff, onRevoke }) {
  const thin = post.trained.length < 2;
  return (
    <section className="card" aria-labelledby={`post-${post.id}`}>
      <div className="card-head">
        <div>
          <h2 id={`post-${post.id}`} className="section-title" style={{ margin: 0 }}>{post.name}</h2>
          <div className="tiny muted">{post.site_name}</div>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {post.armed && <Chip kind="danger">Armed</Chip>}
          <Chip kind={thin ? 'warn' : 'ok'}>{thin ? `Only ${post.trained.length} trained` : `${post.trained.length} trained`}</Chip>
        </div>
      </div>
      <div className="card-pad stack-sm">
        {post.ready.length > 0 && (
          <div>
            <h3 className="tiny strong" style={{ margin: '0 0 4px' }}>Worked here, waiting to be signed off</h3>
            <div className="list">
              {post.ready.map((r) => (
                <Person key={r.user_id} name={r.officer} userId={r.user_id}
                  action={<button className="btn btn-primary btn-sm" onClick={() => onSignOff(post, r)} aria-label={`Sign off ${r.officer} at ${post.name}`}>Sign off</button>}>
                  {s(r.shifts, 'shift')} here in the last 30 days · last {fmtDate(r.last_worked_at)}
                </Person>
              ))}
            </div>
          </div>
        )}
        {post.rostered.length > 0 && (
          <div>
            <h3 className="tiny strong" style={{ margin: '0 0 4px' }}>On the roster here without training</h3>
            <ul className="tight-list small">
              {post.rostered.map((r) => (
                <li key={`${r.shift_id}`}>
                  <strong>{r.officer}</strong> · {fmtDay(r.starts_at)}, {fmtRange(r.starts_at, r.ends_at)}{' '}
                  <Link className="tiny" to={`/admin/schedule?week=${weekOf(r.starts_at)}&shift=${r.shift_id}`}>Open on the schedule</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h3 className="tiny strong" style={{ margin: '0 0 4px' }}>Trained</h3>
          {post.trained.length === 0 ? (
            <div className="small muted">Nobody yet.</div>
          ) : (
            <div className="list">
              {post.trained.map((q) => (
                <Person key={q.id} name={q.officer} userId={q.user_id}
                  action={<button className="btn btn-ghost btn-sm" onClick={() => onRevoke(q)} aria-label={`Withdraw ${q.officer}'s training at ${post.name}`}>Withdraw</button>}>
                  {q.method_label} · {fmtDate(q.trained_at)}{q.signed_off_by_name ? ` · ${q.signed_off_by_name}` : ''}
                  {q.last_worked_at ? ` · last worked ${fmtDate(q.last_worked_at)}` : ''}
                </Person>
              ))}
            </div>
          )}
        </div>
        {(post.lapsed.length > 0 || post.revoked.length > 0) && (
          <div>
            <h3 className="tiny strong" style={{ margin: '0 0 4px' }}>Needs signing off again</h3>
            <div className="list">
              {[...post.lapsed, ...post.revoked].map((q) => (
                <Person key={q.id} name={q.officer} userId={q.user_id}
                  action={<button className="btn btn-ghost btn-sm" onClick={() => onSignOff(post, { user_id: q.user_id, officer: q.officer })} aria-label={`Sign ${q.officer} off again at ${post.name}`}>Sign off again</button>}>
                  <Chip kind={STATE_CHIP[q.state][0]}>{STATE_CHIP[q.state][1]}</Chip>{' '}
                  {q.state === 'revoked'
                    ? `${fmtDate(q.revoked_at)}${q.revoked_by_name ? ` by ${q.revoked_by_name}` : ''}: ${q.revoke_reason}`
                    : `Trained ${fmtDate(q.trained_at)}, ${q.last_worked_at ? `last worked ${fmtDate(q.last_worked_at)}` : 'not worked here since'}`}
                </Person>
              ))}
            </div>
          </div>
        )}
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => onSignOff(post, null)} aria-label={`Sign an officer off at ${post.name}`}>
            <Icon name="plus" size={14} /> Sign an officer off
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * The posts that need site training: who can work each one alone, who has
 * worked a shift there and is waiting to be signed off, and who is on the
 * roster there without it.
 */
export default function SiteTrainingPage() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [signing, setSigning] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get('/site-training'));
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);
  const done = () => {
    setSigning(null);
    setRevoking(null);
    load();
  };

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Workforce</div>
        <h1>Site training</h1>
        <p className="lead">
          Posts that need site training are worked alone only by officers a supervisor has signed off there. Officers cannot claim or swap into
          them until then, and training lapses after {QUALIFICATION_LAPSE_DAYS} days away from the post. Choose which posts need it under{' '}
          <Link to="/admin/sites">Sites &amp; posts</Link>.
        </p>
      </div>

      {!data ? (
        <LoadingPage label="Loading site training" />
      ) : data.posts.length === 0 ? (
        <div className="card">
          <Empty icon="shield" title="No post needs site training">
            Tick <strong>Needs site training</strong> on a post under Sites &amp; posts to start.
          </Empty>
        </div>
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Posts that need it" value={data.counts.posts} foot={data.counts.thin ? `${data.counts.thin} with fewer than two trained` : 'Each with two or more trained'} alert={data.counts.thin > 0} />
            <Stat label="Officers signed off" value={data.counts.trained} foot={data.counts.lapsed ? `${data.counts.lapsed} more ${data.counts.lapsed === 1 ? 'needs' : 'need'} a refresher` : 'All current'} />
            <Stat label="Waiting for sign-off" value={data.counts.ready} foot="Worked a post, not yet signed off" />
            <Stat label="On the roster untrained" value={data.counts.rostered} foot="Shifts in the next two weeks" alert={data.counts.rostered > 0} />
          </div>
          {data.counts.rostered > 0 && (
            <Banner kind="warn" title={`${s(data.counts.rostered, 'shift')} in the next two weeks with an officer not trained at the post`}>
              Pair each with a trained officer as a training shift, then sign them off, or give the shift to someone trained. The alerts inbox flags
              those in the coming week.
            </Banner>
          )}
          <div className="grid grid-2">
            {data.posts.map((p) => (
              <PostCard key={p.id} post={p} onSignOff={(post, person) => setSigning({ post, person })} onRevoke={setRevoking} />
            ))}
          </div>
        </>
      )}

      {signing && <SignOffDialog post={signing.post} person={signing.person} onClose={() => setSigning(null)} onDone={done} />}
      {revoking && <RevokeDialog q={revoking} onClose={() => setRevoking(null)} onDone={done} />}
    </div>
  );
}
