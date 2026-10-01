import { useState } from 'react';
import { Banner, Field, Icon, Shield } from '../components/ui.jsx';
import { LICENCE_CLASSES, LICENCE_CLASS_LABEL } from '@shared/domain.js';

const blank = {
  firstName: '', lastName: '', email: '', phone: '', city: '',
  licenceClass: 'D', licenceNumber: '', licenceExpiresOn: '', experience: '', availability: '', website: '',
};

/**
 * The public job application. No account and no session: it posts to
 * /api/apply and the hiring team picks it up from there.
 */
export default function ApplyPage() {
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setErrors({});
    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          city: form.city || null,
          licenceNumber: form.licenceClass === 'none' ? null : form.licenceNumber || null,
          licenceExpiresOn: form.licenceClass === 'none' ? null : form.licenceExpiresOn || null,
          experience: form.experience || null,
          availability: form.availability || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const fields = {};
        for (const d of data.details || []) if (d.field) fields[d.field] = d.message;
        setErrors(fields);
        setError(data.error || 'That did not go through. Please try again.');
        return;
      }
      setDone(true);
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <main className="auth-card apply-card" id="main">
        <div className="auth-brand">
          <Shield size={72} shine />
          <div className="center">
            <h1 className="name" style={{ margin: 0, fontSize: '1.3rem' }}>Work with us</h1>
            <div className="sub">USA Security &amp; Protection Group</div>
          </div>
        </div>

        {done ? (
          <div className="stack center">
            <div className="apply-done-icon" aria-hidden="true">
              <Icon name="check" size={30} />
            </div>
            <h2 style={{ margin: 0 }}>Thank you - we have your application</h2>
            <p className="muted" style={{ margin: 0 }}>
              We have emailed you a copy. Someone from our hiring team will call you, usually within two working days.
            </p>
          </div>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <p className="small muted" style={{ margin: 0 }}>
              Unarmed and armed officer posts across Florida: offices, hospitals, logistics yards, marinas and residential
              gates. Full-time and part-time shifts, days and nights.
            </p>
            {error && <Banner kind="danger">{error}</Banner>}
            <div className="grid grid-2">
              <Field label="First name" required error={errors.firstName}>
                <input value={form.firstName} onChange={set('firstName')} autoComplete="given-name" maxLength={60} />
              </Field>
              <Field label="Last name" required error={errors.lastName}>
                <input value={form.lastName} onChange={set('lastName')} autoComplete="family-name" maxLength={60} />
              </Field>
            </div>
            <Field label="Email" required error={errors.email}>
              <input type="email" value={form.email} onChange={set('email')} autoComplete="email" maxLength={160} />
            </Field>
            <div className="grid grid-2">
              <Field label="Phone" required error={errors.phone}>
                <input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" maxLength={30} />
              </Field>
              <Field label="City" error={errors.city}>
                <input value={form.city} onChange={set('city')} autoComplete="address-level2" maxLength={80} />
              </Field>
            </div>
            <Field label="Florida security licence" error={errors.licenceClass}>
              <select value={form.licenceClass} onChange={set('licenceClass')}>
                {LICENCE_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {LICENCE_CLASS_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            {form.licenceClass !== 'none' && (
              <div className="grid grid-2">
                <Field label="Licence number" error={errors.licenceNumber}>
                  <input value={form.licenceNumber} onChange={set('licenceNumber')} maxLength={30} />
                </Field>
                <Field label="Expires" error={errors.licenceExpiresOn}>
                  <input type="date" value={form.licenceExpiresOn} onChange={set('licenceExpiresOn')} />
                </Field>
              </div>
            )}
            <Field label="Experience" hint="Security, military, law enforcement, customer service - anything relevant." error={errors.experience}>
              <textarea rows={3} value={form.experience} onChange={set('experience')} maxLength={2000} />
            </Field>
            <Field label="When can you work?" hint="e.g. nights and weekends" error={errors.availability}>
              <input value={form.availability} onChange={set('availability')} maxLength={300} />
            </Field>
            {/* Left empty by people; filled in by bots. */}
            <div className="hp-field" aria-hidden="true">
              <label>
                Website
                <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
              </label>
            </div>
            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
              {busy ? 'Sending...' : 'Send my application'}
            </button>
          </form>
        )}

        <p className="tiny muted center" style={{ marginTop: 20, marginBottom: 0 }}>
          Already work with us? <a href="/">Sign in</a>
          <br />
          Licensed Florida security agency &middot; B 3400341
        </p>
      </main>
    </div>
  );
}
