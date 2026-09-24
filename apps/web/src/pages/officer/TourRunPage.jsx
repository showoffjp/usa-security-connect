import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { getPosition } from '../../lib/geo.js';
import { fmtTime } from '../../lib/format.js';
import {
  LoadingPage, Icon, Chip, Modal, Field, Progress, useToast, Banner, StatusChip,
} from '../../components/ui.jsx';

/** Checkpoint tasks: tick each one, or skip with a reason. */
function CheckpointSheet({ checkpoint, runId, onUpdated, onClose }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manualTag, setManualTag] = useState('');

  const setTask = async (task, status) => {
    setBusy(true);
    try {
      onUpdated(await api.patch(`/tours/runs/${runId}/tasks/${task.id}`, { status }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const scan = async (tagId) => {
    setScanning(true);
    try {
      const fix = await getPosition({ timeout: 7000 });
      const res = await api.post(`/tours/runs/${runId}/checkpoints/${checkpoint.checkpoint_id}/scan`, {
        method: tagId ? 'nfc' : 'manual',
        tagId: tagId || undefined,
        latitude: fix.ok ? fix.latitude : null,
        longitude: fix.ok ? fix.longitude : null,
      });
      onUpdated(res);
      toast.success(`${checkpoint.name} recorded.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setScanning(false);
    }
  };

  const allTasksDone = checkpoint.tasks.every((t) => t.status !== 'pending');

  return (
    <Modal
      title={checkpoint.name}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          {checkpoint.status === 'pending' && (
            <button className="btn btn-primary" onClick={() => scan(checkpoint.nfc_tag_id)} disabled={scanning}>
              <Icon name="check" size={16} />
              {scanning ? 'Recording...' : allTasksDone ? 'Complete checkpoint' : 'Mark visited'}
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        {checkpoint.instructions && <Banner kind="info">{checkpoint.instructions}</Banner>}

        {checkpoint.status !== 'pending' && (
          <div className="row">
            <StatusChip value={checkpoint.status} />
            {checkpoint.scanned_at && <span className="small muted">at {fmtTime(checkpoint.scanned_at)}</span>}
          </div>
        )}

        {checkpoint.tasks.length > 0 && (
          <div>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 6 }}>
              Checkpoint tasks
            </div>
            <div className="card">
              <div className="list">
                {checkpoint.tasks.map((t) => (
                  <div key={t.id} className="list-item" style={{ cursor: 'default', padding: '11px 14px' }}>
                    <button
                      className="icon-btn"
                      style={{
                        background: t.status === 'done' ? 'var(--ok)' : 'var(--surface-3)',
                        color: t.status === 'done' ? '#fff' : 'var(--muted)',
                        width: 26, height: 26, borderRadius: 999, flex: 'none',
                      }}
                      onClick={() => setTask(t, t.status === 'done' ? 'pending' : 'done')}
                      disabled={busy}
                      aria-label={t.status === 'done' ? 'Mark not done' : 'Mark done'}
                    >
                      <Icon name="check" size={14} stroke={3} />
                    </button>
                    <span
                      className="grow small"
                      style={{
                        textDecoration: t.status === 'skipped' ? 'line-through' : 'none',
                        color: t.status === 'skipped' ? 'var(--muted)' : 'inherit',
                      }}
                    >
                      {t.label}
                    </span>
                    {t.status !== 'done' && (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setTask(t, t.status === 'skipped' ? 'pending' : 'skipped')}
                        disabled={busy}
                      >
                        {t.status === 'skipped' ? 'Undo' : 'Skip'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {checkpoint.status === 'pending' && (
          <details>
            <summary className="small strong" style={{ cursor: 'pointer', color: 'var(--navy-700)' }}>
              Scan the tag instead
            </summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <Banner kind="info" title="NFC on this device">
                The mobile app reads the tag directly. In the browser, type the tag ID printed on the checkpoint.
              </Banner>
              <Field label="Tag ID">
                <input
                  value={manualTag}
                  onChange={(e) => setManualTag(e.target.value)}
                  placeholder={checkpoint.nfc_tag_id || 'USC-NFC-...'}
                />
              </Field>
              <button className="btn btn-navy" onClick={() => scan(manualTag.trim())} disabled={!manualTag.trim() || scanning}>
                <Icon name="nfc" size={16} /> Verify tag
              </button>
            </div>
          </details>
        )}
      </div>
    </Modal>
  );
}

function SkipDialog({ checkpoint, runId, onUpdated, onClose }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      onUpdated(await api.post(`/tours/runs/${runId}/checkpoints/${checkpoint.checkpoint_id}/skip`, { reason: reason.trim() }));
      toast.toast('Checkpoint skipped - your supervisor will see the reason.');
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Skip ${checkpoint.name}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={submit} disabled={reason.trim().length < 3 || busy}>
            Skip checkpoint
          </button>
        </>
      }
    >
      <Field label="Why are you skipping it?" hint="This is recorded on the tour record." required>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Area locked down by the client for maintenance." />
      </Field>
    </Modal>
  );
}

export default function TourRunPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [skip, setSkip] = useState(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setData(await api.get(`/tours/runs/${runId}`));
      } catch (err) {
        toast.error(err.message);
        navigate('/tours', { replace: true });
      }
    })();
  }, [runId, navigate, toast]);

  // Keep the open sheet in sync after each scan / task change.
  const update = (next) => {
    setData(next);
    if (sheet) {
      const fresh = next.checkpoints.find((c) => c.checkpoint_id === sheet.checkpoint_id);
      setSheet(fresh || null);
    }
  };

  const finish = async () => {
    setFinishing(true);
    try {
      const res = await api.post(`/tours/runs/${runId}/complete`);
      toast.success(
        res.run.status === 'completed_with_skips' ? 'Tour finished with skipped checkpoints.' : 'Tour completed.'
      );
      navigate('/tours', { replace: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setFinishing(false);
    }
  };

  if (!data) return <LoadingPage label="Loading tour" />;

  const { run, progress, checkpoints } = data;
  const finished = run.status !== 'in_progress';

  return (
    <div className="page stack">
      <div className="row" style={{ marginBottom: 2 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tours')}>
          <Icon name="back" size={16} /> Tours
        </button>
      </div>

      <div className="card card-pad stack">
        <div className="row-between">
          <div>
            <h2>{run.tour_name}</h2>
            <div className="small muted">
              {run.site_name} &middot; started {fmtTime(run.started_at)}
            </div>
          </div>
          <Chip kind={progress.done === progress.total ? 'ok' : 'brand'}>
            {progress.done}/{progress.total}
          </Chip>
        </div>
        <Progress label="Checkpoints completed" value={progress.done} max={progress.total} ok={progress.done === progress.total} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Checkpoints</h3>
          <span className="small muted">In order</span>
        </div>
        <div className="list">
          {checkpoints.map((c) => {
            const doneTasks = c.tasks.filter((t) => t.status === 'done').length;
            return (
              <div key={c.id} className="list-item" style={{ cursor: 'default' }}>
                <div
                  className="lead-icon"
                  style={
                    c.status === 'done'
                      ? { background: 'var(--ok-bg)', color: 'var(--ok)' }
                      : c.status === 'skipped'
                        ? { background: 'var(--warn-bg)', color: 'var(--warn)' }
                        : undefined
                  }
                >
                  <Icon name={c.status === 'done' ? 'check' : c.status === 'skipped' ? 'x' : 'pin'} size={18} />
                </div>
                <button
                  className="grow"
                  style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit', padding: 0 }}
                  onClick={() => setSheet(c)}
                >
                  <div className="strong small">
                    {c.name}
                    {!c.required && <span className="muted tiny"> (optional)</span>}
                  </div>
                  <div className="tiny muted">
                    {c.tasks.length > 0 ? `${doneTasks}/${c.tasks.length} tasks` : 'No tasks'}
                    {c.scanned_at ? ` - ${fmtTime(c.scanned_at)}` : ''}
                    {c.skip_reason ? ` - ${c.skip_reason}` : ''}
                  </div>
                </button>
                {!finished && c.status === 'pending' && (
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => setSkip(c)}>
                      Skip
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => setSheet(c)}>
                      Open
                    </button>
                  </div>
                )}
                {c.status !== 'pending' && <StatusChip value={c.status} />}
              </div>
            );
          })}
        </div>
      </div>

      {!finished && (
        <button className="btn btn-primary btn-lg btn-block" onClick={finish} disabled={finishing}>
          <Icon name="check" size={18} />
          {finishing ? 'Finishing...' : 'Finish tour'}
        </button>
      )}

      {sheet && (
        <CheckpointSheet
          checkpoint={sheet}
          runId={runId}
          onUpdated={update}
          onClose={() => setSheet(null)}
        />
      )}
      {skip && (
        <SkipDialog checkpoint={skip} runId={runId} onUpdated={setData} onClose={() => setSkip(null)} />
      )}
    </div>
  );
}
