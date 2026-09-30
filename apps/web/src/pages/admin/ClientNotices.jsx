import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime, toLocalInput } from '../../lib/format.js';
import { Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, useToast } from '../../components/ui.jsx';

const LEVEL_LABEL = { info: 'Information', important: 'Important', urgent: 'Urgent' };
const STATE_CHIP = {
  live: ['ok', 'Live'],
  scheduled: ['info', 'Scheduled'],
  ended: ['', 'Ended'],
  withdrawn: ['', 'Withdrawn'],
};

function NewNotice({ sites, onClose, onPosted }) {
  const toast = useToast();
  const inAMonth = new Date(Date.now() + 30 * 86400000);
  const [form, setForm] = useState({
    title: '',
    body: '',
    level: 'info',
    allSites: true,
    siteIds: [],
    startsAt: toLocalInput(new Date()),
    endsAt: toLocalInput(inAMonth),
    email: false,
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleSite = (id) =>
    setForm((f) => ({ ...f, siteIds: f.siteIds.includes(id) ? f.siteIds.filter((x) => x !== id) : [...f.siteIds, id] }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const d = await api.post('/admin/client-notices', {
        title: form.title,
        body: form.body,
        level: form.level,
        allSites: form.allSites,
        siteIds: form.allSites ? [] : form.siteIds,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        email: form.email,
      });
      toast.success(d.emailed ? `Notice posted and emailed to ${d.emailed} contact${d.emailed === 1 ? '' : 's'}.` : 'Notice posted.');
      onPosted();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  const ready = form.title.trim().length >= 3 && form.body.trim().length >= 10 && (form.allSites || form.siteIds.length > 0);
  return (
    <Modal
      title="New notice to clients"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>
            {busy ? 'Posting...' : 'Post notice'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title" required error={errors.title}>
          <input value={form.title} onChange={set('title')} maxLength={120} placeholder="e.g. Holiday coverage over Thanksgiving" />
        </Field>
        <Field label="Message" required error={errors.body}>
          <textarea rows={5} value={form.body} onChange={set('body')} maxLength={2000} />
        </Field>
        <div>
          <div className="small strong" style={{ marginBottom: 6 }}>
            How it shows
          </div>
          <Segmented
            label="How it shows"
            value={form.level}
            onChange={(v) => setForm((f) => ({ ...f, level: v }))}
            options={[
              { value: 'info', label: 'Information' },
              { value: 'important', label: 'Important' },
              { value: 'urgent', label: 'Urgent' },
            ]}
          />
        </div>
        <fieldset className="visit-checks">
          <legend>Who sees it</legend>
          <label className="check">
            <input type="checkbox" checked={form.allSites} onChange={(e) => setForm((f) => ({ ...f, allSites: e.target.checked }))} />
            Every property
          </label>
          {!form.allSites && (
            <div className="notice-sites">
              {sites.map((s) => (
                <label key={s.id} className="check">
                  <input type="checkbox" checked={form.siteIds.includes(s.id)} onChange={() => toggleSite(s.id)} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
          {errors.siteIds && <span className="small" style={{ color: "var(--danger)" }} role="alert">{errors.siteIds}</span>}
        </fieldset>
        <div className="grid grid-2">
          <Field label="Shows from" error={errors.startsAt}>
            <input type="datetime-local" value={form.startsAt} onChange={set('startsAt')} />
          </Field>
          <Field label="Until" error={errors.endsAt} hint="Leave empty to keep it up until you withdraw it.">
            <input type="datetime-local" value={form.endsAt} onChange={set('endsAt')} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.checked }))} />
          Also email it to every contact who can see it, now
        </label>
      </div>
    </Modal>
  );
}

/** Notices to client contacts: what is up, where, and who has read it. */
export function NoticesTab({ sites }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [posting, setPosting] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/client-notices'));
    } catch (err) {
      toast.error(err.message);
      setData({ notices: [], live: 0 });
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const withdraw = async (n) => {
    if (!window.confirm(`Take down "${n.title}"? It leaves the portal straight away.`)) return;
    try {
      await api.post(`/admin/client-notices/${n.id}/withdraw`);
      toast.success('Notice withdrawn.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!data) return <LoadingPage label="Loading notices" />;
  return (
    <div className="stack">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <p className="small muted" style={{ margin: 0 }}>
          A notice shows at the top of the portal for the properties it is for, until each contact marks it read.
        </p>
        <button className="btn btn-primary" onClick={() => setPosting(true)}>
          <Icon name="plus" size={16} /> New notice
        </button>
      </div>
      <div className="card">
        {data.notices.length === 0 ? (
          <Empty icon="megaphone" title="No notices yet" />
        ) : (
          <ul className="list">
            {data.notices.map((n) => {
              const [kind, label] = STATE_CHIP[n.state] || ['', n.state];
              return (
                <li key={n.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'default' }}>
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <strong className="small">{n.title}</strong>
                      <Chip kind={kind}>{label}</Chip>
                      <Chip kind={n.level === 'urgent' ? 'danger' : n.level === 'important' ? 'warn' : ''}>{LEVEL_LABEL[n.level]}</Chip>
                      {n.emailed_at && <Chip>Emailed</Chip>}
                    </div>
                    <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.body}</div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {n.all_sites ? 'Every property' : n.sites.map((s) => s.name).join(', ')} · {fmtDateTime(n.starts_at)}
                      {n.ends_at ? ` to ${fmtDateTime(n.ends_at)}` : ', no end'} · read by {n.reads} of {n.audience} contact
                      {n.audience === 1 ? '' : 's'}
                      {n.created_by_name ? ` · posted by ${n.created_by_name}` : ''}
                    </div>
                  </div>
                  {['live', 'scheduled'].includes(n.state) && (
                    <button className="btn btn-sm btn-ghost" onClick={() => withdraw(n)}>
                      Withdraw
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {posting && (
        <NewNotice
          sites={sites}
          onClose={() => setPosting(false)}
          onPosted={() => {
            setPosting(false);
            load();
          }}
        />
      )}
    </div>
  );
}
