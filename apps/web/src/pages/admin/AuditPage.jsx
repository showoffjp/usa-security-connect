import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import { LoadingPage, Empty, Icon, Chip, useToast } from '../../components/ui.jsx';

/** Icon + tone per action family, so the log is scannable. */
const STYLES = {
  login: { icon: 'user', kind: '' },
  logout: { icon: 'logout', kind: '' },
  pin: { icon: 'shield', kind: 'brand' },
  timeclock: { icon: 'clock', kind: 'info' },
  checkin: { icon: 'check', kind: 'ok' },
  incident: { icon: 'alert', kind: 'warn' },
  employee: { icon: 'users', kind: 'navy' },
  shift: { icon: 'calendar', kind: 'info' },
  flag: { icon: 'flag', kind: 'warn' },
  tour: { icon: 'route', kind: '' },
  broadcast: { icon: 'megaphone', kind: 'brand' },
  training: { icon: 'book', kind: '' },
  visit: { icon: 'pin', kind: '' },
  export: { icon: 'download', kind: 'navy' },
  time_entry: { icon: 'clock', kind: 'warn' },
};

export default function AuditPage() {
  const toast = useToast();
  const [entries, setEntries] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setEntries((await api.get('/admin/audit')).entries);
      } catch (err) {
        toast.error(err.message);
        setEntries([]);
      }
    })();
  }, [toast]);

  const families = useMemo(() => {
    const set = new Set((entries || []).map((e) => e.action.split('.')[0]));
    return [...set].sort();
  }, [entries]);

  const filtered = useMemo(
    () => (entries || []).filter((e) => !filter || e.action.startsWith(filter)),
    [entries, filter]
  );

  if (!entries) return <LoadingPage label="Loading audit log" />;

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Configuration</div>
          <h1>Audit log</h1>
          <p className="lead">
            Every sign-in, clock event, PIN reset and record change, with who did it.
          </p>
        </div>
        <select
          aria-label="Filter by activity type"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 'auto' }}
        >
          <option value="">All activity</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <Empty icon="clipboard" title="No activity recorded" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Entity</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const family = e.action.split('.')[0];
                  const style = STYLES[family] || { icon: 'clipboard', kind: '' };
                  let detail = e.detail;
                  try {
                    const parsed = JSON.parse(e.detail);
                    detail = Object.entries(parsed)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ');
                  } catch {
                    /* plain string detail */
                  }
                  return (
                    <tr key={e.id}>
                      <td className="nowrap small">
                        {fmtDateTime(e.created_at)}
                        <div className="tiny muted">{fmtRelative(e.created_at)}</div>
                      </td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <Icon name={style.icon} size={15} />
                          <Chip kind={style.kind}>{e.action}</Chip>
                        </span>
                      </td>
                      <td className="small">
                        {e.actor || <span className="muted">system</span>}
                        {e.employee_code && <div className="tiny muted mono">{e.employee_code}</div>}
                      </td>
                      <td className="small muted">
                        {e.entity ? `${e.entity}${e.entity_id ? ` #${e.entity_id}` : ''}` : '--'}
                      </td>
                      <td className="tiny muted" style={{ maxWidth: 320 }}>
                        {detail || '--'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
