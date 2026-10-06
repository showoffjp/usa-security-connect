import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDay, fmtRange } from '../../lib/format.js';
import { Chip, Empty } from '../../components/ui.jsx';

const STATE = {
  trained: ['ok', 'Trained'],
  lapsed: ['warn', 'Needs a refresher'],
  revoked: ['danger', 'Withdrawn'],
};

/** On an officer's record: the posts they are signed off at, and training shifts coming up. */
export default function SiteTrainingCard({ userId, name }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get(`/site-training/officers/${userId}`).then(setData, () => setData(null));
  }, [userId]);
  if (!data) return null;
  return (
    <div className="card" id="site-training">
      <div className="card-head">
        <h3>Site training</h3>
        <Link className="small" to="/admin/site-training">All posts</Link>
      </div>
      {data.posts.length === 0 && data.training_shifts.length === 0 ? (
        <Empty icon="shield" title="Not signed off anywhere yet">
          {name} has not been signed off at a post that needs site training.
        </Empty>
      ) : (
        <div className="list">
          {data.training_shifts.map((t) => (
            <div key={t.shift_id} className="list-item" style={{ cursor: 'default' }}>
              <div className="grow">
                <div className="small strong">{t.post_name}</div>
                <div className="tiny muted">{t.site_name} · {fmtDay(t.starts_at)}, {fmtRange(t.starts_at, t.ends_at)}</div>
              </div>
              <Chip kind="warn">Training shift</Chip>
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
                      : `${p.method_label}, ${fmtDate(p.trained_at)}${p.signed_off_by_name ? ` · ${p.signed_off_by_name}` : ''}${p.note ? ` · ${p.note}` : ''}`}
                  </div>
                </div>
                <Chip kind={kind}>{label}</Chip>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
