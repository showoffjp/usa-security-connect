import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDateTime, fmtRelative } from '../lib/format.js';
import { Chip, Empty, Icon, LoadingPage, Modal, Segmented, useToast } from './ui.jsx';

const SEVERITY = { critical: ['danger', 'Critical'], warning: ['warn', 'Warning'], info: ['', 'Info'] };
const KIND_ICON = {
  duress: 'shield', flag: 'flag', watchlist: 'eye', issue: 'building', feedback: 'message', coverage: 'plus', licence: 'book', tour: 'route', orders: 'clipboard', followup: 'check', visit: 'shield', visit_due: 'pin', invoice_query: 'dollar', applicant: 'user', call: 'phone',
};

/**
 * The supervisor's inbox: a bell in the top bar with the unread count, and
 * a panel listing everything waiting on them. Opening an alert takes them to
 * the screen where it is dealt with and marks it read.
 */
export default function AlertsBell() {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState('unread');

  const load = useCallback(async () => {
    try {
      setData(await api.get('/admin/alerts'));
    } catch {
      /* the bell simply stays as it was; each screen reports its own failures */
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, location.pathname]);

  const markRead = async (body) => {
    try {
      await api.post('/admin/alerts/read', body);
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  };
  const go = (a) => {
    setOpen(false);
    if (!a.read) markRead({ keys: [a.key] });
    navigate(a.link);
  };

  const unread = data?.unread || 0;
  const list = !data ? [] : show === 'unread' ? data.alerts.filter((a) => !a.read) : data.alerts;

  return (
    <>
      <button
        className="icon-btn bell-btn"
        onClick={() => setOpen(true)}
        aria-label={unread ? `Alerts, ${unread} unread` : 'Alerts'}
        title="Alerts"
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className="bell-count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <Modal
          title="Alerts"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>
                Close
              </button>
              <button className="btn btn-primary" onClick={() => markRead({ all: true })} disabled={!unread}>
                <Icon name="check" size={15} /> Mark all read
              </button>
            </>
          }
        >
          <div className="stack">
            <Segmented
              label="Show"
              value={show}
              onChange={setShow}
              options={[
                { value: 'unread', label: `Unread${unread ? ` (${unread})` : ''}` },
                { value: 'all', label: 'All' },
              ]}
            />
            {!data ? (
              <LoadingPage label="Loading alerts" />
            ) : list.length === 0 ? (
              <Empty icon="check" title={show === 'unread' ? 'Nothing new. You are all caught up.' : 'Nothing needs you right now'} />
            ) : (
              <ul className="list alerts-list">
                {list.map((a) => {
                  const [kind, label] = SEVERITY[a.severity] || SEVERITY.info;
                  return (
                    <li key={a.key}>
                      <button className={`list-item alert-item${a.read ? ' read' : ' unread'}`} onClick={() => go(a)}>
                        <span className={`lead-icon alert-${a.severity}`} aria-hidden="true">
                          <Icon name={KIND_ICON[a.kind] || 'alert'} size={16} />
                        </span>
                        <span className="grow">
                          <span className="row wrap" style={{ gap: 6 }}>
                            <strong className="small">{a.title}</strong>
                            {a.severity !== 'info' && <Chip kind={kind}>{label}</Chip>}
                            {!a.read && <span className="sr-only">Unread.</span>}
                          </span>
                          <span className="tiny muted" style={{ display: 'block' }}>
                            {a.detail}
                            {a.detailAt ? ` ${fmtDateTime(a.detailAt)}` : ''}
                            {a.at && a.kind !== 'licence' ? ` · ${fmtRelative(a.at)}` : ''}
                          </span>
                        </span>
                        <Icon name="chevron" size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
