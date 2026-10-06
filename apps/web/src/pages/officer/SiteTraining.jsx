import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDay, fmtRange } from '../../lib/format.js';
import { Chip, Icon } from '../../components/ui.jsx';

const STATE = {
  trained: ['ok', 'Trained'],
  lapsed: ['warn', 'Needs a refresher'],
  revoked: ['danger', 'Withdrawn'],
};

/**
 * On the profile: the posts that need site training which this officer is
 * cleared for, and any training shifts coming up.
 */
export function MySiteTraining() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/site-training/mine').then(setData, () => setData(null));
  }, []);
  if (!data || (!data.posts.length && !data.training_shifts.length)) return null;
  return (
    <div className="card" id="site-training">
      <div className="card-head">
        <h3>
          <Icon name="shield" size={18} /> Site training
        </h3>
        <span className="small muted">
          {(() => {
            const n = data.posts.filter((p) => p.state === 'trained').length;
            return `Cleared for ${n} post${n === 1 ? '' : 's'}`;
          })()}
        </span>
      </div>
      <div className="list">
        {data.training_shifts.map((t) => (
          <div key={t.shift_id} className="list-item" style={{ cursor: 'default' }}>
            <div className="grow">
              <div className="small strong">
                <Chip kind="warn">Training shift</Chip> {t.post_name}
              </div>
              <div className="tiny muted">
                {t.site_name} · {fmtDay(t.starts_at)}, {fmtRange(t.starts_at, t.ends_at)}. Work it alongside a trained officer; a supervisor signs
                you off afterwards.
              </div>
            </div>
          </div>
        ))}
        {data.posts.map((p) => {
          const [kind, label] = STATE[p.state] || ['', p.state];
          return (
            <div key={p.id} className="list-item" style={{ cursor: 'default' }}>
              <div className="grow">
                <div className="small strong">{p.post_name}</div>
                <div className="tiny muted">
                  {p.site_name} ·{' '}
                  {p.state === 'revoked'
                    ? `withdrawn ${fmtDate(p.revoked_at)}: ${p.revoke_reason}`
                    : `${p.method_label}, ${fmtDate(p.trained_at)}${p.signed_off_by_name ? ` · signed off by ${p.signed_off_by_name}` : ''}`}
                </div>
              </div>
              <Chip kind={kind}>{label}</Chip>
            </div>
          );
        })}
      </div>
    </div>
  );
}
