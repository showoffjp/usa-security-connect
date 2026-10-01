import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useDemo } from '../lib/demo.js';
import { Shield, Icon, Spinner, Banner } from '../components/ui.jsx';

/**
 * PINs are 4 to 6 digits: the server accepts either, a reset can issue six and
 * the first administrator's is six. A six-digit PIN signs in by itself; a
 * shorter one with the Sign in button or Enter.
 */
const PIN_MIN = 4;
const PIN_MAX = 6;

/** Shown only on a self-contained demo deployment, whose accounts are public. */
const DEMO_ACCOUNTS = [
  { code: '1001', pin: '2468', who: 'Vince Ortega', role: 'Administrator' },
  { code: '1002', pin: '3571', who: 'Renata Diaz', role: 'Supervisor' },
  { code: '1003', pin: '4812', who: 'Marcus Bell', role: 'Officer, on duty' },
  { code: '1004', pin: '5930', who: 'Janelle Carter', role: 'Officer, licence expiring' },
  { code: '1005', pin: '6174', who: 'Dwayne Foster', role: '1099 contractor, armed' },
  { code: '1006', pin: '7285', who: 'Alicia Nunez', role: 'Officer, W-2 hourly' },
  { code: '1007', pin: '8140', who: 'Kevin Osei', role: 'Officer, new hire' },
  { code: '1008', pin: '9351', who: 'Renee Okafor', role: '1099 contractor, per shift' },
];

export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState('code');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const codeRef = useRef(null);
  const demo = useDemo();

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  const submitCode = (e) => {
    e.preventDefault();
    if (!/^[0-9]{4,6}$/.test(code)) {
      setError('Enter the 4-digit employee code printed on your assignment sheet.');
      return;
    }
    setError('');
    setStep('pin');
  };

  const attempt = async (fullPin, withCode = code) => {
    setBusy(true);
    setError('');
    try {
      const res = await signIn(withCode, fullPin);
      // On success the router swaps this screen out. Supervisors and
      // administrators start in the admin console rather than the officer view;
      // an officer signing in on a tab left at an admin address starts at home.
      const staff = ['admin', 'supervisor'].includes(res?.user?.role);
      if (staff && window.location.pathname === '/') navigate('/admin', { replace: true });
      else if (!staff && window.location.pathname.startsWith('/admin')) navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setPin('');
      setBusy(false);
    }
  };

  const pressKey = (digit) => {
    if (busy || pin.length >= PIN_MAX) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_MAX) attempt(next);
  };

  const submitPin = () => {
    if (!busy && pin.length >= PIN_MIN) attempt(pin);
  };

  // Let a physical keyboard drive the keypad too - most posts have one.
  useEffect(() => {
    if (step !== 'pin') return;
    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key)) pressKey(e.key);
      else if (e.key === 'Enter') submitPin();
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Escape') {
        setStep('code');
        setPin('');
        setError('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <Shield size={72} shine />
          <div className="center">
            <div className="name">USA Security Connect</div>
            <div className="sub">Protection Group</div>
          </div>
        </div>

        {demo && step === 'code' && (
          <div className="demo-accounts" style={{ marginBottom: 14 }}>
            <div className="small strong">Demo site - tap an account to sign in</div>
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.code}
                type="button"
                className="btn btn-ghost btn-block"
                disabled={busy}
                onClick={() => {
                  setCode(a.code);
                  setPin(a.pin);
                  setStep('pin');
                  attempt(a.pin, a.code);
                }}
              >
                <span className="demo-codes mono">
                  {a.code} / {a.pin}
                </span>
                <span className="demo-who">
                  {a.who}
                  <span className="tiny muted"> · {a.role}</span>
                </span>
              </button>
            ))}
            <div className="tiny muted">
              Codes 1009-1042 sign in too; the README lists each one with its PIN. 1043 is on leave, so it is refused by design.
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="danger">{error}</Banner>
          </div>
        )}

        {step === 'code' ? (
          <form onSubmit={submitCode} className="stack">
            <div className="field">
              <label htmlFor="employeeCode">Employee code</label>
              <input
                id="employeeCode"
                ref={codeRef}
                inputMode="numeric"
                autoComplete="username"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="0000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                style={{ fontSize: '1.5rem', letterSpacing: '0.35em', textAlign: 'center', fontWeight: 600 }}
              />
              <span className="hint">Your supervisor issues this code and your starting PIN.</span>
            </div>
            <button className="btn btn-primary btn-lg btn-block" type="submit">
              Continue <Icon name="chevron" size={18} />
            </button>
          </form>
        ) : (
          <div className="stack">
            <div className="center">
              <div className="small muted">Employee code</div>
              <div className="strong mono" style={{ fontSize: '1.15rem', letterSpacing: '0.2em' }}>
                {code}
              </div>
            </div>

            <div>
              <div className="center small muted" style={{ marginBottom: 8 }}>
                Enter your PIN
              </div>
              <div className="pin-display" aria-hidden="true">
                {Array.from({ length: Math.max(PIN_MIN, pin.length) }).map((_, i) => (
                  <span key={i} className={`pin-dot${i < pin.length ? ' filled' : ''}`} />
                ))}
              </div>
              <label className="sr-only" htmlFor="pin">
                PIN
              </label>
              <input
                id="pin"
                className="sr-only"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={pin}
                onChange={() => {}}
              />
            </div>

            {busy ? (
              <div className="center" style={{ padding: '26px 0' }}>
                <Spinner dark />
                <div className="small muted" style={{ marginTop: 8 }}>
                  Signing in...
                </div>
              </div>
            ) : (
              <div className="keypad">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <button key={n} type="button" onClick={() => pressKey(String(n))}>
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  className="action"
                  onClick={() => {
                    setStep('code');
                    setPin('');
                    setError('');
                  }}
                >
                  Back
                </button>
                <button type="button" onClick={() => pressKey('0')}>
                  0
                </button>
                <button type="button" className="action" onClick={() => setPin((p) => p.slice(0, -1))}>
                  Delete
                </button>
              </div>
            )}
            {!busy && (
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                onClick={submitPin}
                disabled={pin.length < PIN_MIN}
              >
                Sign in
              </button>
            )}
          </div>
        )}

        <p className="tiny muted center" style={{ marginTop: 20, marginBottom: 0 }}>
          Forgotten your PIN? Contact your field supervisor for a reset.
          <br />
          Looking for work? <a href="/apply">Apply to join us</a>
          <br />
          Licensed Florida security agency &middot; B 3400341
        </p>
      </div>
    </div>
  );
}
