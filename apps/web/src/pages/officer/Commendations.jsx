import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';
import { Chip, Icon, useToast } from '../../components/ui.jsx';

function useMine() {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get('/commendations/mine').then(setData, () => setData({ commendations: [], unseen: 0 }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return [data, load];
}

function Quote({ c }) {
  return (
    <div className="commendation">
      <div className="row wrap" style={{ gap: 6 }}>
        <Chip kind="ok">{c.category_label}</Chip>
        <span className="tiny muted">
          {c.from}
          {c.site_name ? ` · ${c.site_name}` : ''} · {fmtDate(c.created_at)}
        </span>
      </div>
      <p className="small" style={{ margin: '6px 0 0' }}>{c.message}</p>
    </div>
  );
}

/** On the home screen: thanks the officer has not read yet. */
export function NewCommendations() {
  const toast = useToast();
  const [data, load] = useMine();
  if (!data || !data.unseen) return null;
  const fresh = data.commendations.filter((c) => !c.seen);
  const done = async () => {
    try {
      await api.post('/commendations/mine/seen');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <div className="card" id="commended">
      <div className="card-head wrap">
        <h3>
          <Icon name="check" size={18} /> You were commended
        </h3>
        <button className="btn btn-ghost btn-sm" onClick={done}>
          Thanks, got it
        </button>
      </div>
      <div className="card-body stack">
        {fresh.slice(0, 3).map((c) => (
          <Quote key={c.id} c={c} />
        ))}
      </div>
    </div>
  );
}

/** On the profile: every one, newest first. */
export function MyCommendations() {
  const [data] = useMine();
  if (!data || data.commendations.length === 0) return null;
  return (
    <div className="card" id="commendations">
      <div className="card-head">
        <h3>Commendations</h3>
        <span className="small muted">{data.commendations.length}</span>
      </div>
      <div className="card-body stack">
        {data.commendations.slice(0, 10).map((c) => (
          <Quote key={c.id} c={c} />
        ))}
      </div>
    </div>
  );
}
