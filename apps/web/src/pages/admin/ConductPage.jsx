import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Chip, Empty, Icon, LoadingPage, Segmented, Stat, useToast } from '../../components/ui.jsx';
import { CONDUCT_ACTIVE_MONTHS, CONDUCT_SIGN_DAYS, CONDUCT_LEVEL_LABEL } from '@shared/domain.js';
import { IssueDialog, LEVEL_KIND, RecordItem, RefusedDialog, RescindDialog } from './ConductParts.jsx';

/**
 * Coaching and discipline across the force: who stands where, what is still
 * waiting for the officer's signature, and every record from the last year.
 */
export default function ConductPage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const focus = Number(params.get('record')) || null;
  const [data, setData] = useState(null);
  const [view, setView] = useState('active');
  const [issuing, setIssuing] = useState(false);
  const [refusing, setRefusing] = useState(null);
  const [rescinding, setRescinding] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get('/conduct'));
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (data && focus) document.getElementById(`record-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [data, focus]);
  const done = () => {
    setIssuing(false);
    setRefusing(null);
    setRescinding(null);
    load();
  };

  const waiting = data?.records.filter((r) => r.awaiting_signature) || [];
  const shown = (data?.records || []).filter((r) => (view === 'active' ? r.active : true));

  return (
    <div className="page stack">
      <div className="page-head row-between wrap" style={{ marginBottom: 0, gap: 12 }}>
        <div>
          <div className="eyebrow">Workforce</div>
          <h1>Coaching &amp; discipline</h1>
          <p className="lead">
            Each step on an officer's record, from coaching to suspension, read and signed by the officer. A record counts towards the next
            step for {CONDUCT_ACTIVE_MONTHS} months. Final warnings and suspensions are an administrator's decision; clients never see any of it.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setIssuing(true)}>
          <Icon name="plus" size={16} /> Record a step
        </button>
      </div>

      {!data ? (
        <LoadingPage label="Loading records" />
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Counting now" value={data.counts.active} foot={`Records from the last ${CONDUCT_ACTIVE_MONTHS} months`} />
            <Stat label="Waiting for a signature" value={data.counts.awaiting_signature}
              foot={data.counts.overdue ? `${data.counts.overdue} for more than ${CONDUCT_SIGN_DAYS} days` : 'None overdue'} alert={data.counts.overdue > 0} />
            <Stat label="On a final warning" value={data.counts.final_warnings} foot="Or suspended this year" alert={data.counts.final_warnings > 0} />
            <Stat label="Suspended today" value={data.counts.suspended_now} foot="Kept off the roster" />
          </div>

          <div className="grid grid-2">
            <section className="card" aria-labelledby="standing-title">
              <div className="card-head">
                <h2 id="standing-title" className="section-title" style={{ margin: 0 }}>Where officers stand</h2>
                <span className="small muted">{data.officers.length}</span>
              </div>
              {data.officers.length === 0 ? (
                <Empty icon="check" title="Nobody on a record">Nobody has a step that still counts.</Empty>
              ) : (
                <div className="list">
                  {data.officers.map((o) => (
                    <div key={o.user_id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="grow">
                        <Link className="small strong" to={`/admin/employees/${o.user_id}#conduct`}>{o.name}</Link>
                        <div className="tiny muted">
                          {o.active} record{o.active === 1 ? '' : 's'} counting
                          {o.awaiting_signature ? ` · ${o.awaiting_signature} to sign` : ''} · next for attendance: {CONDUCT_LEVEL_LABEL[o.next.attendance].toLowerCase()}
                        </div>
                      </div>
                      {o.level && <Chip kind={LEVEL_KIND[o.level]}>{o.level_label}</Chip>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="card" aria-labelledby="waiting-title">
              <div className="card-head">
                <h2 id="waiting-title" className="section-title" style={{ margin: 0 }}>Waiting for the officer's signature</h2>
                <span className="small muted">{waiting.length}</span>
              </div>
              {waiting.length === 0 ? (
                <Empty icon="check" title="Everything is signed">Every record has been signed, or the refusal recorded.</Empty>
              ) : (
                <div className="list">
                  {waiting.map((r) => (
                    <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="grow">
                        <div className="small strong">{r.officer} · {r.level_label}</div>
                        <div className="tiny muted">
                          {r.category_label} · issued {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {r.signature_overdue ? ` · over ${CONDUCT_SIGN_DAYS} days` : ''}
                        </div>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => setRefusing(r)} aria-label={`Record that ${r.officer} refused to sign`}>
                        Refused to sign
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="card" aria-labelledby="records-title">
            <div className="card-head wrap" style={{ gap: 8 }}>
              <h2 id="records-title" className="section-title" style={{ margin: 0 }}>Records</h2>
              <Segmented label="Show" value={view} onChange={setView}
                options={[{ value: 'active', label: 'Counting' }, { value: 'all', label: 'Last year, all' }]} />
            </div>
            {shown.length === 0 ? (
              <Empty icon="clipboard" title="No records">Nothing recorded {view === 'active' ? 'that still counts' : 'in the last year'}.</Empty>
            ) : (
              <div className="list">
                {shown.map((r) => (
                  <RecordItem key={r.id} r={r} open={r.id === focus} onRefused={setRefusing} onRescind={setRescinding} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {issuing && <IssueDialog onClose={() => setIssuing(false)} onDone={done} />}
      {refusing && <RefusedDialog r={refusing} onClose={() => setRefusing(null)} onDone={done} />}
      {rescinding && <RescindDialog r={rescinding} onClose={() => setRescinding(null)} onDone={done} />}
    </div>
  );
}
