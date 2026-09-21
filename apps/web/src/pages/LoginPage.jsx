import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { Shield, Icon, Spinner, Banner } from '../components/ui.jsx';

const PIN_LENGTH = 4;

export default function LoginPage() {
  const { signIn } = useAuth();
  const [step, setStep] = useState('code');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const codeRef = useRef(null);

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

  const attempt = async (fullPin) => {
    setBusy(true);
    setError('');
    try {
      await signIn(code, fullPin);
      // On success the router swaps this screen out.
    } catch (err) {
      setError(err.message);
      setPin('');
      setBusy(false);
    }
  };

  const pressKey = (digit) => {
    if (busy || pin.length >= PIN_LENGTH) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_LENGTH) attempt(next);
  };

  // Let a physical keyboard drive the keypad too - most posts have one.
  useEffect(() => {
    if (step !== 'pin') return;
    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key)) pressKey(e.key);
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
          <Shield size={56} />
          <div className="center">
            <div className="name">USA Security Connect</div>
            <div className="sub">Protection Group</div>
          </div>
        </div>

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
                Enter your {PIN_LENGTH}-digit PIN
              </div>
              <div className="pin-display" aria-hidden="true">
                {Array.from({ length: PIN_LENGTH }).map((_, i) => (
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
          </div>
        )}

        <p className="tiny muted center" style={{ marginTop: 20, marginBottom: 0 }}>
          Forgotten your PIN? Contact your field supervisor for a reset.
          <br />
          Licensed Florida security agency &middot; B 3400341
        </p>
      </div>
    </div>
  );
}
