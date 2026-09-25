import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative, fmtDate } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Segmented, Progress, Field, useToast, Banner,
} from '../../components/ui.jsx';

/* --------------------------------------------------------- broadcasts -- */

function BroadcastList() {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(null);

  const load = async () => {
    try {
      setItems((await api.get('/broadcasts')).broadcasts);
    } catch (err) {
      toast.error(err.message);
      setItems([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const openItem = async (b) => {
    setOpen(b);
    if (b.unread) {
      try {
        await api.post(`/broadcasts/${b.id}/receipt`, {});
        load();
      } catch {
        /* reading it matters more than recording the receipt */
      }
    }
  };

  const acknowledge = async () => {
    try {
      await api.post(`/broadcasts/${open.id}/receipt`, { acknowledge: true });
      toast.success('Acknowledged.');
      setOpen(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!items) return <LoadingPage />;
  if (!items.length)
    return (
      <div className="card">
        <Empty icon="megaphone" title="No messages" >Company-wide notices appear here.</Empty>
      </div>
    );

  return (
    <>
      <div className="card">
        <div className="list">
          {items.map((b) => (
            <button key={b.id} className={`list-item${b.unread ? ' unread' : ''}`} onClick={() => openItem(b)}>
              <div
                className="lead-icon"
                style={
                  b.priority === 'urgent'
                    ? { background: 'var(--danger-bg)', color: 'var(--danger)' }
                    : b.priority === 'important'
                      ? { background: 'var(--warn-bg)', color: 'var(--warn)' }
                      : undefined
                }
              >
                <Icon name="megaphone" size={18} />
              </div>
              <div className="grow">
                <div className="row" style={{ gap: 7 }}>
                  <span className="title small strong truncate">{b.title}</span>
                  {b.priority !== 'normal' && <StatusChip value={b.priority} />}
                  {b.needs_ack && <Chip kind="brand">Action needed</Chip>}
                </div>
                <div className="tiny muted truncate">{b.body}</div>
                <div className="tiny muted">
                  {b.author} &middot; {fmtRelative(b.published_at)}
                </div>
              </div>
              {b.unread && <span className="dot" style={{ color: 'var(--brand-600)' }} />}
            </button>
          ))}
        </div>
      </div>

      {open && (
        <Modal
          title={open.title}
          onClose={() => setOpen(null)}
          footer={
            open.needs_ack ? (
              <button className="btn btn-primary" onClick={acknowledge}>
                <Icon name="check" size={16} /> I have read and understood
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={() => setOpen(null)}>
                Close
              </button>
            )
          }
        >
          <div className="stack">
            <div className="row wrap">
              <StatusChip value={open.priority} />
              <span className="small muted">
                {open.author} &middot; {fmtDateTime(open.published_at)}
              </span>
            </div>
            <p style={{ whiteSpace: 'pre-line' }}>{open.body}</p>
            {open.acknowledged_at && (
              <Banner kind="ok">Acknowledged {fmtDateTime(open.acknowledged_at)}.</Banner>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ----------------------------------------------------------- training -- */

/**
 * Required training must be watched through.
 *
 * A course with a video plays it; one without falls back to a timed stand-in,
 * so a course can be published before its footage exists. Either way the
 * counter only advances in real time and cannot be scrubbed forward, and the
 * server enforces the same rule independently - the player is a convenience,
 * not the control.
 */
function TrainingPlayer({ training, onClose, onDone }) {
  const toast = useToast();
  const [seconds, setSeconds] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [saving, setSaving] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const startedFrom = useRef(training.seconds_watched || 0);
  const video = useRef(null);

  const hasVideo = Boolean(training.video_url) && !videoFailed;

  useEffect(() => {
    setSeconds(startedFrom.current);
  }, []);

  // With a real video the element is the clock; otherwise a timer stands in.
  useEffect(() => {
    if (hasVideo || !playing) return;
    const t = setInterval(() => {
      setSeconds((s) => {
        const next = s + 1;
        if (next >= training.duration_seconds) {
          setPlaying(false);
          return training.duration_seconds;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [hasVideo, playing, training.duration_seconds]);

  // Resume where they left off, once the file knows how long it is.
  const onLoaded = () => {
    const el = video.current;
    if (el && startedFrom.current > 0 && startedFrom.current < el.duration) {
      el.currentTime = startedFrom.current;
    }
  };

  /**
   * Count watched time, not position.
   *
   * Taking currentTime directly would let someone drag the scrubber to the end
   * and be credited with the whole course.
   */
  const onTimeUpdate = () => {
    const el = video.current;
    if (!el) return;
    setSeconds((s) => Math.max(s, Math.min(Math.floor(el.currentTime), training.duration_seconds)));
  };

  const watchedEnough = seconds >= Math.floor(training.duration_seconds * 0.95);

  const complete = async () => {
    setSaving(true);
    try {
      await api.post(`/training/${training.id}/progress`, { secondsWatched: seconds, completed: true });
      toast.success('Training recorded.');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <Modal
      title={training.title}
      onClose={async () => {
        // Save partial progress so the officer can pick it up later.
        try {
          await api.post(`/training/${training.id}/progress`, { secondsWatched: seconds });
          onDone();
        } catch {
          /* progress is best-effort */
        }
        onClose();
      }}
      footer={
        <>
          {!hasVideo && (
            <button className="btn btn-ghost" onClick={() => setPlaying((p) => !p)}>
              <Icon name="play" size={16} /> {playing ? 'Pause' : 'Resume'}
            </button>
          )}
          <button className="btn btn-primary" onClick={complete} disabled={!watchedEnough || saving}>
            {watchedEnough ? 'Mark complete' : 'Watch in full to continue'}
          </button>
        </>
      }
    >
      <div className="stack">
        {training.required && (
          <Banner kind="warn" title="Required training">
            You must watch this in full before it can be marked complete.
          </Banner>
        )}
        <div
          style={{
            aspectRatio: '16/9', borderRadius: 'var(--r-md)', overflow: 'hidden',
            background: 'linear-gradient(140deg, var(--navy-900), var(--navy-700))',
            display: 'grid', placeItems: 'center', color: '#fff', position: 'relative',
          }}
        >
          {hasVideo ? (
            <video
              ref={video}
              src={training.video_url}
              poster={training.poster_url || undefined}
              controls
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
              playsInline
              onLoadedMetadata={onLoaded}
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setSeconds(training.duration_seconds)}
              onError={() => setVideoFailed(true)}
              style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
            />
          ) : (
            <div className="center">
              <Icon name={playing ? 'play' : 'book'} size={44} />
              <div className="small" style={{ marginTop: 8, opacity: 0.8 }}>
                {training.video_url ? 'Video unavailable - timed instead' : playing ? 'Playing' : 'Paused'}
              </div>
            </div>
          )}
          <div
            style={{
              position: 'absolute', left: 12, right: 12, bottom: 10,
              pointerEvents: 'none',
              ...(hasVideo
                ? { bottom: 'auto', top: 10, background: 'rgba(0,21,43,0.72)', padding: '6px 10px', borderRadius: 8 }
                : null),
            }}
          >
            <Progress label="How much you have watched" value={seconds} max={training.duration_seconds} ok={watchedEnough} />
            <div className="row-between tiny" style={{ marginTop: 5, opacity: 0.85 }}>
              <span>{mmss(seconds)}</span>
              <span>{mmss(training.duration_seconds)}</span>
            </div>
          </div>
        </div>
        {training.description && <p className="small muted">{training.description}</p>}
      </div>
    </Modal>
  );
}

function TrainingList() {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(null);

  const load = async () => {
    try {
      setItems((await api.get('/training')).trainings);
    } catch (err) {
      toast.error(err.message);
      setItems([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (!items) return <LoadingPage />;
  if (!items.length)
    return (
      <div className="card">
        <Empty icon="book" title="No training assigned" />
      </div>
    );

  return (
    <>
      <div className="card">
        <div className="list">
          {items.map((t) => (
            <div key={t.id} className="list-item" style={{ cursor: 'default' }}>
              <div
                className="lead-icon"
                style={t.watched ? { background: 'var(--ok-bg)', color: 'var(--ok)' } : undefined}
              >
                <Icon name={t.watched ? 'check' : 'play'} size={18} />
              </div>
              <div className="grow">
                <div className="row" style={{ gap: 7 }}>
                  <span className="strong small">{t.title}</span>
                  {Boolean(t.required) && <Chip kind={t.watched ? 'ok' : 'danger'}>Required</Chip>}
                  {t.overdue && <Chip kind="danger">Overdue</Chip>}
                </div>
                <div className="tiny muted">{t.description}</div>
                {t.due_at && !t.watched && <div className="tiny muted">Due {fmtDate(t.due_at)}</div>}
                {!t.watched && t.percent > 0 && (
                  <div style={{ marginTop: 5, maxWidth: 200 }}>
                    <Progress label={`Progress through ${t.title}`} value={t.percent} max={100} />
                  </div>
                )}
              </div>
              <button className="btn btn-sm btn-primary" onClick={() => setOpen(t)}>
                {t.watched ? 'Rewatch' : t.percent > 0 ? 'Resume' : 'Watch'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {open && <TrainingPlayer training={open} onClose={() => setOpen(null)} onDone={load} />}
    </>
  );
}

/* ----------------------------------------------------------- messages -- */

function MessageList() {
  const toast = useToast();
  const [threads, setThreads] = useState(null);
  const [active, setActive] = useState(null);
  const [thread, setThread] = useState(null);
  const [draft, setDraft] = useState('');
  const [compose, setCompose] = useState(false);

  const loadThreads = async () => {
    try {
      setThreads((await api.get('/messages/threads')).threads);
    } catch (err) {
      toast.error(err.message);
      setThreads([]);
    }
  };
  useEffect(() => {
    loadThreads();
  }, []);

  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        setThread(await api.get(`/messages/threads/${active}`));
      } catch (err) {
        toast.error(err.message);
      }
    })();
  }, [active, toast]);

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    const body = draft.trim();
    setDraft('');
    try {
      const res = await api.post(`/messages/threads/${active}/messages`, { body });
      setThread((t) => ({ ...t, messages: [...t.messages, res.message] }));
      loadThreads();
    } catch (err) {
      toast.error(err.message);
      setDraft(body);
    }
  };

  if (!threads) return <LoadingPage />;

  return (
    <>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <span className="small muted">Direct messages with supervisors and dispatch.</span>
        <button className="btn btn-sm btn-navy" onClick={() => setCompose(true)}>
          <Icon name="plus" size={15} /> New
        </button>
      </div>

      {threads.length === 0 ? (
        <div className="card">
          <Empty icon="message" title="No conversations" >Start one with your supervisor.</Empty>
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {threads.map((t) => (
              <button key={t.id} className={`list-item${t.unread > 0 ? ' unread' : ''}`} onClick={() => setActive(t.id)}>
                <div className="lead-icon">
                  <Icon name="message" size={18} />
                </div>
                <div className="grow">
                  <div className="title small strong truncate">{t.subject || t.participants}</div>
                  <div className="tiny muted truncate">{t.preview}</div>
                  <div className="tiny muted">{t.participants}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="tiny muted">{fmtRelative(t.last_message_at)}</div>
                  {t.unread > 0 && <Chip kind="brand">{t.unread}</Chip>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {active && thread && (
        <Modal
          title={thread.thread.subject || thread.participants.map((p) => p.name).join(', ')}
          onClose={() => {
            setActive(null);
            setThread(null);
            loadThreads();
          }}
          footer={
            <form onSubmit={send} className="row" style={{ width: '100%' }}>
              <input
                className="grow"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write a reply"
                autoFocus
              />
              <button className="btn btn-primary" disabled={!draft.trim()}>
                Send
              </button>
            </form>
          }
        >
          <div className="stack-sm">
            {thread.messages.map((m) => (
              <div
                key={m.id}
                style={{
                  alignSelf: m.mine ? 'flex-end' : 'flex-start',
                  maxWidth: '82%',
                  background: m.mine ? 'var(--navy-800)' : 'var(--surface-3)',
                  color: m.mine ? '#fff' : 'var(--ink)',
                  padding: '9px 13px',
                  borderRadius: 14,
                }}
              >
                {!m.mine && <div className="tiny strong" style={{ opacity: 0.7 }}>{m.sender_name}</div>}
                <div className="small">{m.body}</div>
                <div className="tiny" style={{ opacity: 0.6, marginTop: 2 }}>{fmtRelative(m.sent_at)}</div>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {compose && <ComposeDialog onClose={() => setCompose(false)} onSent={(id) => { setCompose(false); loadThreads(); setActive(id); }} />}
    </>
  );
}

function ComposeDialog({ onClose, onSent }) {
  const toast = useToast();
  const [contacts, setContacts] = useState([]);
  const [form, setForm] = useState({ subject: '', recipientIds: [], body: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/messages/contacts').then((r) => setContacts(r.contacts)).catch(() => {});
  }, []);

  const send = async () => {
    setBusy(true);
    try {
      const res = await api.post('/messages/threads', form);
      onSent(res.threadId);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New message"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={send} disabled={busy || !form.recipientIds.length || !form.body.trim()}>
            Send
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="To" required>
          <select
            multiple
            size={Math.min(6, Math.max(3, contacts.length))}
            value={form.recipientIds.map(String)}
            onChange={(e) =>
              setForm((f) => ({ ...f, recipientIds: [...e.target.selectedOptions].map((o) => Number(o.value)) }))
            }
          >
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.role})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subject">
          <input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
        </Field>
        <Field label="Message" required>
          <textarea value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- page -- */

export default function UpdatesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'broadcasts';

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">Communication</div>
        <h1>Updates</h1>
      </div>

      <Segmented
          label="Updates view"
        value={tab}
        onChange={(v) => setParams(v === 'broadcasts' ? {} : { tab: v })}
        options={[
          { value: 'broadcasts', label: 'Broadcasts' },
          { value: 'training', label: 'Training' },
          { value: 'messages', label: 'Messages' },
        ]}
      />

      {tab === 'broadcasts' && <BroadcastList />}
      {tab === 'training' && <TrainingList />}
      {tab === 'messages' && <MessageList />}
    </div>
  );
}
