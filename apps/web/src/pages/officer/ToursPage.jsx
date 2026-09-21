import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, StatusChip, useToast } from '../../components/ui.jsx';

export default function ToursPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [starting, setStarting] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [tours, runs] = await Promise.all([api.get('/tours'), api.get('/tours/runs?limit=8')]);
        setData(tours);
        setHistory(runs.runs);
      } catch (err) {
        toast.error(err.message);
        setData({ tours: [], activeRun: null });
      }
    })();
  }, [toast]);

  const start = async (tour) => {
    setStarting(tour.id);
    try {
      const run = await api.post(`/tours/${tour.id}/start`);
      navigate(`/tours/${run.run.id}`);
    } catch (err) {
      // Already walking a tour - take them to it rather than failing.
      if (err.status === 409 && err.details?.activeRunId) {
        navigate(`/tours/${err.details.activeRunId}`);
        return;
      }
      toast.error(err.message);
    } finally {
      setStarting(null);
    }
  };

  if (!data) return <LoadingPage label="Loading tours" />;

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="eyebrow">Patrol</div>
        <h1>Tours &amp; tasks</h1>
        <p className="lead">Walk the route, scan each checkpoint, and tick off the tasks as you go.</p>
      </div>

      {data.activeRun && (
        <button className="card card-pad row" style={{ width: '100%', textAlign: 'left', cursor: 'pointer', borderColor: 'var(--brand-400)' }} onClick={() => navigate(`/tours/${data.activeRun.id}`)}>
          <div className="lead-icon" style={{ background: 'var(--brand-100)', color: 'var(--brand-600)' }}>
            <Icon name="route" size={19} />
          </div>
          <div className="grow">
            <div className="strong small">{data.activeRun.tour_name} is in progress</div>
            <div className="tiny muted">Started {fmtRelative(data.activeRun.started_at)}</div>
          </div>
          <span className="btn btn-primary btn-sm">Continue</span>
        </button>
      )}

      {data.tours.length === 0 ? (
        <div className="card">
          <Empty icon="route" title="No tours at this site">
            Tours are set up per site by your administrator. Clock in at a post to see its routes.
          </Empty>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <h3>Available tours</h3>
          </div>
          <div className="list">
            {data.tours.map((t) => (
              <div key={t.id} className="list-item" style={{ cursor: 'default' }}>
                <div className="lead-icon">
                  <Icon name="route" size={18} />
                </div>
                <div className="grow">
                  <div className="strong small">{t.name}</div>
                  <div className="tiny muted">{t.description}</div>
                  <div className="row" style={{ gap: 6, marginTop: 4 }}>
                    <Chip kind="navy">{t.checkpoint_count} checkpoints</Chip>
                    {t.expected_minutes && <Chip>~{t.expected_minutes} min</Chip>}
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => start(t)}
                  disabled={starting === t.id || Boolean(data.activeRun)}
                >
                  {starting === t.id ? 'Starting...' : 'Start'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Recent walks</h3>
          </div>
          <div className="list">
            {history.map((r) => (
              <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="strong small">{r.tour_name}</div>
                  <div className="tiny muted">{fmtDateTime(r.started_at)}</div>
                </div>
                <div className="row" style={{ gap: 7 }}>
                  <span className="tiny muted">
                    {r.done}/{r.total}
                  </span>
                  <StatusChip value={r.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
