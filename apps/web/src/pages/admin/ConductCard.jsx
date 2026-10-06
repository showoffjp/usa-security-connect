import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Chip, Empty, Icon } from '../../components/ui.jsx';
import { CONDUCT_ACTIVE_MONTHS } from '@shared/domain.js';
import { IssueDialog, LEVEL_KIND, RecordItem, RefusedDialog, RescindDialog } from './ConductParts.jsx';

/** On an officer's record: every coaching and warning, and where they stand. */
export default function ConductCard({ userId, name, canIssue }) {
  const [data, setData] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [refusing, setRefusing] = useState(null);
  const [rescinding, setRescinding] = useState(null);
  const load = useCallback(() => {
    api.get(`/conduct/officers/${userId}`).then(setData, () => setData(null));
  }, [userId]);
  useEffect(() => {
    load();
  }, [load]);
  const done = () => {
    setIssuing(false);
    setRefusing(null);
    setRescinding(null);
    load();
  };
  if (!data) return null;
  const s = data.standing;
  return (
    <div className="card" id="conduct">
      <div className="card-head wrap" style={{ gap: 8 }}>
        <h3>Coaching &amp; discipline</h3>
        <div className="row" style={{ gap: 8 }}>
          {s.level ? <Chip kind={LEVEL_KIND[s.level]}>{s.level_label}</Chip> : <Chip kind="ok">Clear</Chip>}
          {canIssue && (
            <button className="btn btn-ghost btn-sm" onClick={() => setIssuing(true)}>
              <Icon name="plus" size={14} /> Record a step
            </button>
          )}
        </div>
      </div>
      {data.records.length === 0 ? (
        <Empty icon="check" title="Nothing on record">{name} has no coaching or warnings.</Empty>
      ) : (
        <>
          <div className="card-pad tiny muted" style={{ paddingBottom: 0 }}>
            {s.active} record{s.active === 1 ? '' : 's'} from the last {CONDUCT_ACTIVE_MONTHS} months count{s.active === 1 ? 's' : ''} towards the next step.
          </div>
          <div className="list">
            {data.records.map((r) => (
              <RecordItem key={r.id} r={r} showOfficer={false} onRefused={setRefusing} onRescind={setRescinding} />
            ))}
          </div>
        </>
      )}
      {issuing && <IssueDialog officer={{ id: userId, name }} onClose={() => setIssuing(false)} onDone={done} />}
      {refusing && <RefusedDialog r={refusing} onClose={() => setRefusing(null)} onDone={done} />}
      {rescinding && <RescindDialog r={rescinding} onClose={() => setRescinding(null)} onDone={done} />}
    </div>
  );
}
