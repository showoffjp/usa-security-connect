import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { clientApi, clientTokenStore } from '../../lib/api.js';
import { Shield, Icon, Spinner, Banner, Field } from '../../components/ui.jsx';

/**
 * Choosing a portal password from a single-use link.
 *
 * The link is checked before the form is shown, so somebody following a stale
 * invitation is told so rather than typing a password into something that was
 * never going to work.
 */
export default function SetPassword({ onDone }) {
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [state, setState] = useState({ status: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ status: 'invalid', message: 'That link is missing its code. Check the whole link was copied.' });
      return;
    }
    let cancelled = false;
    clientApi
      .get(`/client/set-password/${encodeURIComponent(token)}`)
      .then((r) => {
        if (cancelled) return;
        setState(
          r.valid
            ? { status: 'ready', name: r.name, email: r.email, purpose: r.purpose }
            : {
                status: 'invalid',
                message: {
                  used: 'That link has already been used. Ask your account manager for a new one.',
                  expired: 'That link has expired. Ask your account manager for a new one.',
                  inactive: 'This account is not active. Contact your account manager.',
                }[r.reason] || 'That link is no longer valid.',
              }
        );
      })
      .catch((err) => !cancelled && setState({ status: 'invalid', message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const res = await clientApi.post('/client/set-password', {
        token,
        password,
        confirmPassword: confirm,
      });
      // The link signs them straight in; no point asking for what they just chose.
      clientTokenStore.set(res.token);
      onDone();
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
      setBusy(false);
    }
  };

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= 12 && password === confirm && !busy;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <Shield size={56} />
          <div className="center">
            <div className="name">Client Portal</div>
            <div className="sub">USA Security &amp; Protection Group</div>
          </div>
        </div>

        {state.status === 'checking' && (
          <div className="center" style={{ padding: '30px 0' }} role="status">
            <Spinner dark />
            <div className="small muted" style={{ marginTop: 8 }}>
              Checking your link...
            </div>
          </div>
        )}

        {state.status === 'invalid' && (
          <>
            <Banner kind="danger" title="This link cannot be used">
              {state.message}
            </Banner>
            <a className="btn btn-ghost btn-block" href="/portal" style={{ marginTop: 14 }}>
              Go to sign in
            </a>
          </>
        )}

        {state.status === 'ready' && (
          <>
            <p className="small muted center" style={{ marginTop: 0 }}>
              {state.purpose === 'reset' ? 'Choose a new password' : 'Welcome'}, {state.name}.
              <br />
              You are setting the password for <span className="mono">{state.email}</span>.
            </p>

            {error && (
              <div style={{ marginBottom: 14 }}>
                <Banner kind="danger">{error}</Banner>
              </div>
            )}

            <form onSubmit={submit} className="stack">
              <Field
                label="New password"
                required
                hint="At least 12 characters. A short phrase you will remember works well."
                error={fieldErrors.password || (tooShort ? 'Use at least 12 characters.' : '')}
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>

              <Field
                label="Confirm password"
                required
                error={fieldErrors.confirmPassword || (mismatch ? 'The two passwords do not match.' : '')}
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </Field>

              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={!canSubmit}>
                {busy ? (
                  <>
                    <Spinner /> Saving...
                  </>
                ) : (
                  <>
                    Set password and sign in <Icon name="chevron" size={18} />
                  </>
                )}
              </button>
            </form>

            <p className="tiny muted center" style={{ marginTop: 18, marginBottom: 0 }}>
              This link works once. Nobody at USA Security can see the password you choose.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
