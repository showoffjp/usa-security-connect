import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { toLocalInput } from '../../lib/format.js';
import { Field, Icon, Spinner, Banner, useToast } from '../../components/ui.jsx';
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITY } from '@shared/domain.js';

const MAX_PHOTOS = 8;

export default function NewIncidentPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const fileRef = useRef(null);

  const [reference, setReference] = useState({ sites: [], posts: [] });
  const [photos, setPhotos] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    officerName: user.full_name,
    callbackNumber: user.phone || '',
    category: '',
    severity: 'low',
    postId: '',
    occurredAt: toLocalInput(),
    locationText: '',
    whatHappened: '',
    resolution: '',
    otherDetails: '',
    peopleInvolved: '',
    peopleNotified: '',
    policeNotified: false,
    policeReportNumber: '',
    costRecovery: '',
  });

  useEffect(() => {
    (async () => {
      try {
        const [ref, status] = await Promise.all([api.get('/reference'), api.get('/timeclock/status')]);
        setReference(ref);
        // Default to the post the officer is standing on.
        const postId = status.entry?.post_id || status.shift?.post_id;
        if (postId) setForm((f) => ({ ...f, postId: String(postId) }));
      } catch {
        /* the officer can still pick a post manually */
      }
    })();
  }, []);

  const set = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const addPhotos = (files) => {
    const incoming = [...files].filter((f) => f.type.startsWith('image/'));
    const room = MAX_PHOTOS - photos.length;
    if (incoming.length > room) toast.toast(`Only ${MAX_PHOTOS} photos per report.`);
    setPhotos((p) => [
      ...p,
      ...incoming.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file), id: Math.random() })),
    ]);
  };

  // Release the object URLs when the page goes away.
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), [photos]);

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (form.whatHappened.trim().length < 10) next.whatHappened = 'Describe what happened in at least a sentence.';
    if (!form.occurredAt) next.occurredAt = 'Tell us when it happened.';
    else if (new Date(form.occurredAt) > new Date(Date.now() + 60000))
      next.occurredAt = 'The time cannot be in the future.';
    setErrors(next);
    if (Object.keys(next).length) {
      toast.error('Please correct the highlighted fields.');
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      const append = (k, v) => {
        if (v !== '' && v != null && v !== false) fd.append(k, String(v));
      };
      append('officerName', form.officerName);
      append('callbackNumber', form.callbackNumber);
      append('category', form.category);
      append('severity', form.severity);
      append('postId', form.postId);
      append('occurredAt', new Date(form.occurredAt).toISOString());
      append('locationText', form.locationText);
      append('whatHappened', form.whatHappened.trim());
      append('resolution', form.resolution);
      append('otherDetails', form.otherDetails);
      append('peopleInvolved', form.peopleInvolved);
      append('peopleNotified', form.peopleNotified);
      if (form.policeNotified) fd.append('policeNotified', 'true');
      append('policeReportNumber', form.policeReportNumber);
      if (form.costRecovery !== '') fd.append('costRecovery', String(Number(form.costRecovery)));
      photos.forEach((p) => fd.append('photos', p.file));

      const res = await api.upload('/incidents', fd);
      toast.success(`Report ${res.refNumber} submitted.`);
      navigate('/incidents', { replace: true });
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
          <Icon name="back" size={16} /> Back
        </button>
      </div>

      <div className="page-head">
        <div className="eyebrow">Incident report</div>
        <h1>Report an incident</h1>
        <p className="lead">
          Write it as the client will read it: facts, times and what you did. Your supervisor reviews every report.
        </p>
      </div>

      <form onSubmit={submit} className="stack">
        {/* ------------------------------------------------- reporter -- */}
        <div className="card card-pad stack">
          <fieldset>
            <legend>Reporting officer</legend>
            <div className="grid grid-2">
              <Field label="Officer name">
                <input value={form.officerName} onChange={set('officerName')} />
              </Field>
              <Field label="Callback number" hint="Where a supervisor can reach you today.">
                <input type="tel" value={form.callbackNumber} onChange={set('callbackNumber')} placeholder="(904) 555-0100" />
              </Field>
            </div>
          </fieldset>
        </div>

        {/* ------------------------------------------------ what/where -- */}
        <div className="card card-pad stack">
          <fieldset>
            <legend>The incident</legend>
            <div className="stack">
              <div className="grid grid-2">
                <Field label="Category">
                  <select value={form.category} onChange={set('category')}>
                    <option value="">Select a category</option>
                    {INCIDENT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Severity" hint="High or critical pages a supervisor.">
                  <select value={form.severity} onChange={set('severity')}>
                    {INCIDENT_SEVERITY.map((s) => (
                      <option key={s} value={s}>
                        {s[0].toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid grid-2">
                <Field label="Post" error={errors.postId}>
                  <select value={form.postId} onChange={set('postId')}>
                    <option value="">Not post specific</option>
                    {reference.posts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.site_name} - {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="When did it occur?" error={errors.occurredAt} required>
                  <input
                    type="datetime-local"
                    value={form.occurredAt}
                    onChange={set('occurredAt')}
                    max={toLocalInput()}
                    aria-invalid={!!errors.occurredAt}
                  />
                </Field>
              </div>

              <Field label="Where exactly did it occur?" hint="Be specific: floor, door, camera, bay number.">
                <input value={form.locationText} onChange={set('locationText')} placeholder="e.g. North stairwell, level 2" />
              </Field>

              <Field label="What happened?" error={errors.whatHappened} required>
                <textarea
                  value={form.whatHappened}
                  onChange={set('whatHappened')}
                  aria-invalid={!!errors.whatHappened}
                  rows={5}
                  placeholder="Describe what you saw and heard, in order, with times."
                />
              </Field>

              <Field label="How was it resolved?">
                <textarea
                  value={form.resolution}
                  onChange={set('resolution')}
                  rows={3}
                  placeholder="What action did you take, and who did you hand it to?"
                />
              </Field>

              <Field label="Other details">
                <textarea value={form.otherDetails} onChange={set('otherDetails')} rows={2} />
              </Field>
            </div>
          </fieldset>
        </div>

        {/* --------------------------------------------------- people -- */}
        <div className="card card-pad stack">
          <fieldset>
            <legend>People &amp; notifications</legend>
            <div className="stack">
              <div className="grid grid-2">
                <Field label="People involved" hint="Names, or descriptions if unknown.">
                  <input value={form.peopleInvolved} onChange={set('peopleInvolved')} />
                </Field>
                <Field label="People notified" hint="Client contact, dispatch, supervisor.">
                  <input value={form.peopleNotified} onChange={set('peopleNotified')} />
                </Field>
              </div>

              <label className="check">
                <input type="checkbox" checked={form.policeNotified} onChange={set('policeNotified')} />
                <span>Law enforcement was contacted</span>
              </label>

              {form.policeNotified && (
                <Field label="Police report number" hint="If one was issued at the scene.">
                  <input value={form.policeReportNumber} onChange={set('policeReportNumber')} />
                </Field>
              )}

              <Field label="Cost recovery (optional)" hint="Client-estimated value of damage or loss, in dollars.">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.costRecovery}
                  onChange={set('costRecovery')}
                  placeholder="0.00"
                />
              </Field>
            </div>
          </fieldset>
        </div>

        {/* --------------------------------------------------- photos -- */}
        <div className="card card-pad stack">
          <fieldset>
            <legend>Photos ({photos.length}/{MAX_PHOTOS})</legend>
            <div className="photo-grid">
              {photos.length < MAX_PHOTOS && (
                <button type="button" className="ph" onClick={() => fileRef.current?.click()} aria-label="Add photos">
                  <Icon name="camera" size={22} />
                </button>
              )}
              {photos.map((p) => (
                <div key={p.id} style={{ position: 'relative' }}>
                  <img src={p.url} alt="" />
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ position: 'absolute', top: 4, right: 4, width: 24, height: 24, background: 'rgba(0,0,0,0.6)' }}
                    onClick={() => setPhotos((list) => list.filter((x) => x.id !== p.id))}
                    aria-label="Remove photo"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              hidden
              onChange={(e) => {
                addPhotos(e.target.files);
                e.target.value = '';
              }}
            />
          </fieldset>
        </div>

        <Banner kind="info">
          Once submitted, a report cannot be edited. A supervisor can add review notes.
        </Banner>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? <Spinner /> : <Icon name="check" size={18} />}
            {busy ? 'Submitting' : 'Submit report'}
          </button>
        </div>
      </form>
    </div>
  );
}
