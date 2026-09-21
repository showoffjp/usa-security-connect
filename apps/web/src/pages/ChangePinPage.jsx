import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Shield, Field, Banner, Icon, Spinner } from '../components/ui.jsx';
import { isWeakPin } from '@shared/domain.js';

export default function ChangePinPage({ forced = false }) {
  const { changePin, signOut } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ currentPin: '', newPin: '', confirmPin: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value.replace(/\D/g, '') }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');

    const next = {};
    if (!/^\d{4,6}$/.test(form.currentPin)) next.currentPin = 'Enter your current PIN.';
    if (!/^\d{4,6}$/.test(form.newPin)) next.newPin = 'Choose a 4-6 digit PIN.';
    else if (isWeakPin(form.newPin)) next.newPin = 'Avoid repeated digits (1111) and simple runs (1234).';
    if (form.newPin !== form.confirmPin) next.confirmPin = 'The two PINs do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await changePin(form.currentPin, form.newPin, form.confirmPin);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setErrors(err.fieldErrors || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <Shield size={48} />
          <div className="center">
            <div className="name">{forced ? 'Choose your PIN' : 'Change your PIN'}</div>
            <div className="sub">USA Security Connect</div>
          </div>
        </div>

        {forced && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="info" title="One more step">
              You are signed in with the temporary PIN your supervisor issued. Pick your own before you go on post.
            </Banner>
          </div>
        )}
        {error && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="danger">{error}</Banner>
          </div>
        )}

        <form onSubmit={submit} className="stack">
          <Field label={forced ? 'Temporary PIN' : 'Current PIN'} error={errors.currentPin} required>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={6}
              value={form.currentPin}
              onChange={set('currentPin')}
              aria-invalid={!!errors.currentPin}
            />
          </Field>

          <Field
            label="New PIN"
            error={errors.newPin}
            hint="4 to 6 digits. Do not share it - every clock-in is recorded against it."
            required
          >
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={form.newPin}
              onChange={set('newPin')}
              aria-invalid={!!errors.newPin}
            />
          </Field>

          <Field label="Confirm new PIN" error={errors.confirmPin} required>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={form.confirmPin}
              onChange={set('confirmPin')}
              aria-invalid={!!errors.confirmPin}
            />
          </Field>

          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? <Spinner /> : <Icon name="check" size={18} />}
            {busy ? 'Saving' : 'Save PIN'}
          </button>

          <button type="button" className="btn btn-ghost btn-block" onClick={forced ? signOut : () => navigate(-1)}>
            {forced ? 'Sign out' : 'Cancel'}
          </button>
        </form>
      </div>
    </div>
  );
}
