import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtTime, fmtDateTime, fmtRelative } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, useToast } from '../../components/ui.jsx';

const KIND_LABEL = { visitor: 'Visitor', contractor: 'Contractor', delivery: 'Delivery', vendor: 'Vendor', other: 'Other' };

/* -------------------------------------------------------- sign someone in -- */

function SignInDialog({ kinds, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    fullName: '', company: '', kind: 'visitor', purpose: '', host: '', vehiclePlate: '', vehicleDesc: '', badgeNumber: '', notes: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const { visitor } = await api.post('/post-log/visitors', form);
      toast.success(`${visitor.full_name} signed in.`);
      onDone();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Sign someone in"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || form.fullName.trim().length < 2 || form.purpose.trim().length < 2}
          >
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={submit}>
        <Field label="Full name" required error={errors.fullName}>
          <input value={form.fullName} onChange={set('fullName')} autoComplete="off" maxLength={120} />
        </Field>
        <div className="grid grid-2">
          <Field label="Company" error={errors.company}>
            <input value={form.company} onChange={set('company')} maxLength={120} />
          </Field>
          <Field label="Type of visit">
            <select value={form.kind} onChange={set('kind')}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k] || k}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Here for" required error={errors.purpose} hint="What they are doing, in a few words.">
          <input value={form.purpose} onChange={set('purpose')} maxLength={200} />
        </Field>
        <Field label="Visiting" hint="Person, suite or department.">
          <input value={form.host} onChange={set('host')} maxLength={120} />
        </Field>
        <div className="grid grid-3">
          <Field label="Plate">
            <input value={form.vehiclePlate} onChange={set('vehiclePlate')} maxLength={16} style={{ textTransform: 'uppercase' }} />
          </Field>
          <Field label="Vehicle">
            <input value={form.vehicleDesc} onChange={set('vehicleDesc')} maxLength={80} placeholder="White van" />
          </Field>
          <Field label="Badge no.">
            <input value={form.badgeNumber} onChange={set('badgeNumber')} maxLength={20} />
          </Field>
        </div>
        <Field label="Notes">
          <input value={form.notes} onChange={set('notes')} maxLength={300} />
        </Field>
      </form>
    </Modal>
  );
}

function VisitorRow({ v, onDepart }) {
  return (
    <li className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
      <div className="grow">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="strong">{v.full_name}</span>
          <Chip>{KIND_LABEL[v.kind] || v.kind}</Chip>
          {v.badge_number && <span className="tiny muted mono">{v.badge_number}</span>}
        </div>
        <div className="small" style={{ marginTop: 2 }}>
          {v.purpose}
          {v.company ? ` · ${v.company}` : ''}
          {v.host ? ` · for ${v.host}` : ''}
        </div>
        <div className="tiny muted" style={{ marginTop: 3 }}>
          In {fmtTime(v.arrived_at)}
          {v.departed_at ? ` · out ${fmtTime(v.departed_at)}` : ''}
          {v.vehicle_plate ? ` · ${v.vehicle_plate}` : ''}
          {v.vehicle_desc ? ` (${v.vehicle_desc})` : ''}
          {v.logged_by_name ? ` · by ${v.logged_by_name}` : ''}
        </div>
      </div>
      {onDepart && (
        <button className="btn btn-sm btn-ghost" onClick={() => onDepart(v)}>
          Sign out
        </button>
      )}
    </li>
  );
}

/* ------------------------------------------------------------- pass-down -- */

function NoteForm({ onSent }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [important, setImportant] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/post-log/passdown', { body, priority: important ? 'important' : 'normal' });
      toast.success('Left for the next shift.');
      setBody('');
      setImportant(false);
      onSent();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card card-pad stack-sm" onSubmit={send}>
      <label className="strong small" htmlFor="passdown-body">
        Leave a note for the next shift
      </label>
      <textarea
        id="passdown-body"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={1000}
        placeholder="Anything they need to know: a door that sticks, a delivery due, a car to watch."
      />
      <div className="row-between wrap">
        <label className="row small">
          <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} style={{ width: 'auto' }} />
          Mark as important
        </label>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || body.trim().length < 5}>
          <Icon name="check" size={15} /> {busy ? 'Saving...' : 'Leave note'}
        </button>
      </div>
    </form>
  );
}

function NoteRow({ n, onAck }) {
  const unread = !n.mine && !n.acked_at;
  return (
    <li
      className="list-item"
      style={{
        alignItems: 'flex-start',
        cursor: 'default',
        ...(unread && n.priority === 'important' ? { background: 'var(--danger-bg)' } : {}),
      }}
    >
      <div className="grow">
        <div className="row wrap" style={{ gap: 6 }}>
          {n.priority === 'important' && <Chip kind="danger">Important</Chip>}
          {unread ? <Chip kind="warn">Unread</Chip> : n.mine ? <Chip kind="info">Yours</Chip> : <Chip kind="ok">Read</Chip>}
          <span className="tiny muted">
            {n.author_name || 'Someone'} · {fmtRelative(n.created_at)}
          </span>
        </div>
        <div className="small" style={{ marginTop: 5, whiteSpace: 'pre-wrap' }}>{n.body}</div>
      </div>
      {unread && (
        <button className="btn btn-sm btn-navy" onClick={() => onAck(n)}>
          Got it
        </button>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function PostLogPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'visitors' ? 'visitors' : 'passdown';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/post-log'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const ack = async (n) => {
    try {
      await api.post(`/post-log/passdown/${n.id}/ack`);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };
  const depart = async (v) => {
    try {
      await api.post(`/post-log/visitors/${v.id}/depart`);
      toast.success(`${v.full_name} signed out.`);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (error) {
    return (
      <div className="page">
        <Banner kind="danger" title="The post log did not load">{error}</Banner>
      </div>
    );
  }
  if (!data) return <LoadingPage label="Opening the post log" />;

  if (!data.post) {
    return (
      <div className="page stack">
        <div className="page-head">
          <h1>Post log</h1>
        </div>
        <Empty icon="clipboard" title="No post right now" action={<Link className="btn btn-ghost" to="/">Back to home</Link>}>
          The log opens when you clock in, and a few hours before your next shift so you can read the pass-down.
        </Empty>
      </div>
    );
  }

  const onSite = data.visitors?.onSite || [];
  const earlier = data.visitors?.earlier || [];

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">{data.post.site_name}</div>
        <h1>Post log</h1>
        <p className="lead">
          {data.post.post_name}
          {data.post.post_code ? ` (${data.post.post_code})` : ''}
        </p>
      </div>

      {!data.onDuty && (
        <Banner kind="info" title="Before your shift">
          You are due here at {fmtTime(data.post.starts_at)}. Read the pass-down now; the visitor log opens once you clock in.
        </Banner>
      )}

      <Segmented
        label="Log"
        value={tab}
        onChange={(v) => setParams(v === 'visitors' ? { tab: 'visitors' } : {}, { replace: true })}
        options={[
          { value: 'passdown', label: `Pass-down${data.unacked ? ` (${data.unacked})` : ''}` },
          { value: 'visitors', label: `Visitors${onSite.length ? ` (${onSite.length})` : ''}` },
        ]}
      />

      {tab === 'passdown' ? (
        <>
          {data.onDuty && <NoteForm onSent={load} />}
          <div className="card">
            <div className="card-head">
              <h2 className="h3">Notes on this post</h2>
              <span className="small muted">Last 7 days</span>
            </div>
            {data.passdown.length === 0 ? (
              <Empty icon="clipboard" title="Nothing passed down">
                Notes the last shift leaves for this post appear here.
              </Empty>
            ) : (
              <ul className="list">
                {[...data.passdown]
                  .sort((a, b) => Number(!a.mine && !a.acked_at ? 0 : 1) - Number(!b.mine && !b.acked_at ? 0 : 1))
                  .map((n) => (
                    <NoteRow key={n.id} n={n} onAck={ack} />
                  ))}
              </ul>
            )}
          </div>
        </>
      ) : !data.onDuty ? (
        <Empty icon="users" title="Clock in to use the visitor log">
          Visitors are signed in at the post you are on.
        </Empty>
      ) : (
        <>
          <div className="card">
            <div className="card-head">
              <h2 className="h3">On site now</h2>
              <button className="btn btn-primary btn-sm" onClick={() => setSigningIn(true)}>
                <Icon name="plus" size={15} /> Sign someone in
              </button>
            </div>
            {onSite.length === 0 ? (
              <Empty icon="users" title="Nobody signed in">
                Visitors, contractors and deliveries you sign in stay here until they leave.
              </Empty>
            ) : (
              <ul className="list">
                {onSite.map((v) => (
                  <VisitorRow key={v.id} v={v} onDepart={depart} />
                ))}
              </ul>
            )}
          </div>
          {earlier.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2 className="h3">Earlier</h2>
                <span className="small muted">Last 24 hours · {earlier.length}</span>
              </div>
              <ul className="list">
                {earlier.map((v) => (
                  <VisitorRow key={v.id} v={v} />
                ))}
              </ul>
            </div>
          )}
          <p className="tiny muted center" style={{ margin: 0 }}>
            The client sees this log in their daily report. Updated {fmtDateTime(new Date())}.
          </p>
        </>
      )}

      {signingIn && (
        <SignInDialog
          kinds={data.kinds}
          onClose={() => setSigningIn(false)}
          onDone={() => {
            setSigningIn(false);
            load();
          }}
        />
      )}
    </div>
  );
}
