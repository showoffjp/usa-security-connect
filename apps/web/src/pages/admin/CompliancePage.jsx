import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Stat, Modal, Field, Banner, Segmented, useToast,
} from '../../components/ui.jsx';
import { CERTIFICATION_TYPES } from '@shared/domain.js';

function AddCertificationDialog({ employees, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    userId: '',
    type: CERTIFICATION_TYPES[0],
    number: '',
    issuingAuthority: 'Florida Department of Agriculture and Consumer Services',
    issuedOn: '',
    expiresOn: '',
    notes: '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/certifications', {
        ...form,
        userId: Number(form.userId),
        issuedOn: form.issuedOn || null,
        expiresOn: form.expiresOn || null,
      });
      toast.success('Certification recorded.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record a certification"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.userId}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Employee" required>
          <select value={form.userId} onChange={set('userId')}>
            <option value="">Select an employee</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name} ({e.employee_code})
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-2">
          <Field label="Type" required>
            <select value={form.type} onChange={set('type')}>
              {CERTIFICATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Number">
            <input value={form.number} onChange={set('number')} placeholder="D-3391204" />
          </Field>
        </div>

        <Field label="Issuing authority">
          <input value={form.issuingAuthority} onChange={set('issuingAuthority')} />
        </Field>

        <div className="grid grid-2">
          <Field label="Issued">
            <input type="date" value={form.issuedOn} onChange={set('issuedOn')} />
          </Field>
          <Field label="Expires" hint="Alerts start 60 days out.">
            <input type="date" value={form.expiresOn} onChange={set('expiresOn')} />
          </Field>
        </div>

        <Field label="Notes">
          <textarea value={form.notes} onChange={set('notes')} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}

export default function CompliancePage() {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [window, setWindow] = useState('60');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, e] = await Promise.all([
        api.get(`/certifications/expiring?days=${window}`),
        api.get('/admin/employees'),
      ]);
      setItems(c.items);
      setEmployees(e.employees.filter((x) => x.status === 'active'));
    } catch (err) {
      toast.error(err.message);
      setItems([]);
    }
  }, [window, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const expired = (items || []).filter((i) => i.expiry.state === 'expired');
    const expiring = (items || []).filter((i) => i.expiry.state === 'expiring');
    return { expired, expiring };
  }, [items]);

  if (!items) return <LoadingPage label="Loading compliance board" />;

  const row = (item) => (
    <tr key={`${item.source}-${item.id || item.user_id}-${item.type}`}>
      <td>
        <Link to={`/admin/employees/${item.user_id}`} className="strong">
          {item.officer}
        </Link>
        <div className="tiny muted mono">{item.employee_code}</div>
      </td>
      <td className="small">
        {item.type}
        {item.number && <div className="tiny muted mono">{item.number}</div>}
      </td>
      <td>
        <Chip kind={item.source === 'insurance' ? 'warn' : 'navy'}>
          {item.source === 'certification' ? 'Certification' : item.source === 'licence' ? 'State licence' : 'Insurance'}
        </Chip>
      </td>
      <td className="small nowrap">{fmtDate(item.expires_on)}</td>
      <td>
        <StatusChip value={item.expiry.state} />
        <div className="tiny muted">
          {item.expiry.days < 0
            ? `${Math.abs(item.expiry.days)} days ago`
            : `in ${item.expiry.days} days`}
        </div>
      </td>
    </tr>
  );

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Compliance</div>
          <h1>Licensing &amp; certifications</h1>
          <p className="lead">
            Nobody should work an armed post on a lapsed Class G. This is the early warning.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Record certification
        </button>
      </div>

      {groups.expired.length > 0 && (
        <Banner kind="danger" title={`${groups.expired.length} credential${groups.expired.length === 1 ? ' has' : 's have'} expired`}>
          Anyone on this list should be pulled from post until it is renewed.
        </Banner>
      )}

      <div className="grid grid-3">
        <Stat label="Expired" value={groups.expired.length} foot="Act today" alert={groups.expired.length > 0} />
        <Stat label="Expiring soon" value={groups.expiring.length} foot={`Within ${window} days`} />
        <Stat label="Active staff" value={employees.length} foot="Being tracked" />
      </div>

      <div className="row-between wrap">
        <span className="small muted">Look ahead</span>
        <Segmented
          label="Credential status"
          value={window}
          onChange={setWindow}
          options={[
            { value: '30', label: '30 days' },
            { value: '60', label: '60 days' },
            { value: '90', label: '90 days' },
            { value: '180', label: '6 months' },
          ]}
        />
      </div>

      <div className="card">
        {items.length === 0 ? (
          <Empty icon="check" title="Nothing expiring">
            No licences, certifications or insurance lapse in the next {window} days.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Credential</th>
                  <th>Source</th>
                  <th>Expires</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {groups.expired.map(row)}
                {groups.expiring.map(row)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && (
        <AddCertificationDialog
          employees={employees}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}
