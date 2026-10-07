import { useState } from 'react';
import { useClientAuth } from '../../lib/clientAuth.jsx';
import { Shield, Icon, Spinner, Banner, Field } from '../../components/ui.jsx';

export default function PortalLogin() {
  const { signIn } = useClientAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      await signIn(email.trim(), password);
      // On success the router swaps this screen out.
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <Shield size={72} shine />
          <div className="center">
            <div className="name">Client Portal</div>
            <div className="sub">USA Security &amp; Protection Group</div>
          </div>
        </div>

        {error && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="danger">{error}</Banner>
          </div>
        )}

        <form onSubmit={submit} className="stack">
          <Field label="Email address" error={fieldErrors.email}>
            <input
              type="email"
              autoComplete="username"
              autoFocus
              placeholder="you@yourcompany.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Password" error={fieldErrors.password}>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || !email || !password}>
            {busy ? (
              <>
                <Spinner /> Signing in...
              </>
            ) : (
              <>
                Sign in <Icon name="chevron" size={18} />
              </>
            )}
          </button>
        </form>

        <p className="tiny muted center" style={{ marginTop: 20, marginBottom: 0 }}>
          Your account manager sets up this login and can reset your password.
          <br />
          Officers and supervisors sign in{' '}
          <a href="/" style={{ color: 'inherit' }}>
            on the staff app
          </a>
          .
          <br />
          See every screen in the <a href="/tour/" style={{ color: 'inherit' }}>product tour</a>.
          <br />
          Licensed Florida security agency &middot; B 3400341
        </p>
      </div>
    </div>
  );
}
