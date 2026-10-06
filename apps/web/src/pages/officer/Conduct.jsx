import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime } from '../../lib/format.js';
import { Chip, Field, Icon, Modal, useToast } from '../../components/ui.jsx';
import { CONDUCT_ACTIVE_MONTHS } from '@shared/domain.js';

const LEVEL_KIND = { coaching: 'info', verbal_warning: 'warn', written_warning: 'warn', final_warning: 'danger', suspension: 'danger' };

function useMine() {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get('/conduct/mine').then(setData, () => setData({ records: [], awaiting: 0 }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return [data, load];
}

function Body({ r }) {
  return (
    <div className="stack-sm small">
      <div className="row wrap" style={{ gap: 6 }}>
        <Chip kind={LEVEL_KIND[r.level]}>{r.level_label}</Chip>
        <span className="tiny muted">
          {r.category_label} · {fmtDate(r.occurred_on)}{r.issued_by_name ? ` · from ${r.issued_by_name}` : ''}
        </span>
      </div>
      {r.level === 'suspension' && r.suspension_starts_on && (
        <div><strong>Off work:</strong> {fmtDate(r.suspension_starts_on)}{r.suspension_ends_on !== r.suspension_starts_on ? ` to ${fmtDate(r.suspension_ends_on)}` : ''}</div>
      )}
      <div><strong>What happened:</strong> {r.summary}</div>
      <div><strong>Expected from now on:</strong> {r.expectations}</div>
    </div>
  );
}

/** Read a record and sign it, with their side of it if they want. */
function SignDialog({ r, onClose, onDone }) {
  const toast = useToast();
  const { user } = useAuth();
  const [signature, setSignature] = useState('');
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/conduct/mine/${r.id}/acknowledge`, { signature: signature.trim(), statement: statement.trim() || undefined });
      toast.success('Signed. A copy stays on your profile.');
      onDone();
    } catch (err) {
      toast.error(err.message);
      setBusy(false);
    }
  };
  const name = user ? `${user.first_name} ${user.last_name}` : '';
  return (
    <Modal
      title={`${r.level_label} to read and sign`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Not now</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || signature.trim().length < 2}>{busy ? 'Signing...' : 'Sign'}</button>
        </>
      }
    >
      <div className="stack">
        <Body r={r} />
        <Field label="Your side of it" hint="Optional. Kept with the record, word for word.">
          <textarea rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={2000} />
        </Field>
        <Field label="Type your full name to sign" required hint={`Signing says you have read it, not that you agree.${name ? ` Type: ${name}` : ''}`}>
          <input value={signature} onChange={(e) => setSignature(e.target.value)} autoComplete="name" maxLength={120} />
        </Field>
      </div>
    </Modal>
  );
}

/** On the home screen: anything on their record they have not signed yet. */
export function ConductToSign() {
  const [data, load] = useMine();
  const [signing, setSigning] = useState(null);
  if (!data || !data.awaiting) return null;
  const waiting = data.records.filter((r) => r.awaiting_signature);
  return (
    <div className="card" id="to-sign">
      <div className="card-head">
        <h3>
          <Icon name="clipboard" size={18} /> To read and sign
        </h3>
        <span className="small muted">{waiting.length}</span>
      </div>
      <div className="list">
        {waiting.map((r) => (
          <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
            <div className="grow">
              <div className="small strong">{r.level_label}: {r.category_label.toLowerCase()}</div>
              <div className="tiny muted">{fmtDate(r.occurred_on)}{r.issued_by_name ? ` · from ${r.issued_by_name}` : ''}</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setSigning(r)}>Read and sign</button>
          </div>
        ))}
      </div>
      {signing && <SignDialog r={signing} onClose={() => setSigning(null)} onDone={() => { setSigning(null); load(); }} />}
    </div>
  );
}

/** On the profile: the officer's whole record. */
export function MyConduct() {
  const [data, load] = useMine();
  const [signing, setSigning] = useState(null);
  if (!data || !data.records.length) return null;
  return (
    <div className="card" id="my-record">
      <div className="card-head">
        <h3>Coaching &amp; warnings</h3>
        <span className="small muted">{data.records.filter((r) => r.active).length} counting</span>
      </div>
      <div className="card-pad tiny muted" style={{ paddingBottom: 0 }}>
        Each stays on your record for {CONDUCT_ACTIVE_MONTHS} months, unless it is withdrawn.
      </div>
      <div className="list">
        {data.records.map((r) => (
          <div key={r.id} className="list-item" style={{ display: 'block', cursor: 'default', opacity: r.active ? 1 : 0.75 }}>
            <Body r={r} />
            <div className="tiny muted" style={{ marginTop: 6 }}>
              {r.status === 'acknowledged' && `You signed it ${fmtDateTime(r.acknowledged_at)}.`}
              {r.status === 'refused' && 'Recorded as not signed, with a witness.'}
              {r.status === 'rescinded' && `Withdrawn: ${r.rescind_reason}`}
              {r.status !== 'rescinded' && !r.active && ' No longer counts.'}
            </div>
            {r.officer_statement && <div className="small signoff-dispute" style={{ marginTop: 6 }}><strong>Your side:</strong> {r.officer_statement}</div>}
            {r.awaiting_signature && (
              <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => setSigning(r)}>Read and sign</button>
            )}
          </div>
        ))}
      </div>
      {signing && <SignDialog r={signing} onClose={() => setSigning(null)} onDone={() => { setSigning(null); load(); }} />}
    </div>
  );
}
