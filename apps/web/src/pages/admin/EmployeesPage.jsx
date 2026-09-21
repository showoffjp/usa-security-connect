import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Field, Banner, useToast, Segmented,
} from '../../components/ui.jsx';
import { ROLES, ROLE_LABEL, EMPLOYEE_STATUS } from '@shared/domain.js';

/* ------------------------------------------------- credentials handout -- */

/**
 * Shown once, immediately after a PIN is generated. The plaintext PIN exists
 * nowhere else - the server stores only a scrypt hash - so this dialog is the
 * single opportunity to pass it to the officer.
 */
export function CredentialsDialog({ credentials, onClose }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `USA Security Connect\nEmployee code: ${credentials.employeeCode}\nTemporary PIN: ${credentials.pin}`
      );
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Copy failed - write the PIN down instead.');
    }
  };

  return (
    <Modal
      title="Sign-in credentials"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={copy}>
            <Icon name="clipboard" size={16} /> Copy
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Done - I have shared these
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner kind="warn" title="Shown only once">
          {credentials.note}
        </Banner>
        <div className="grid grid-2">
          <div className="card card-pad center">
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700 }}>
              Employee code
            </div>
            <div className="mono" style={{ fontSize: '1.9rem', fontWeight: 700, letterSpacing: '0.16em' }}>
              {credentials.employeeCode}
            </div>
          </div>
          <div className="card card-pad center" style={{ borderColor: 'var(--brand-400)' }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700 }}>
              Temporary PIN
            </div>
            <div
              className="mono"
              style={{ fontSize: '1.9rem', fontWeight: 700, letterSpacing: '0.16em', color: 'var(--brand-600)' }}
            >
              {credentials.pin}
            </div>
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          The officer will be required to choose their own PIN the first time they sign in.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------ create / edit -- */

function EmployeeDialog({ employee, sites, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(employee);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    firstName: employee?.first_name || '',
    lastName: employee?.last_name || '',
    employeeCode: employee?.employee_code || '',
    email: employee?.email || '',
    phone: employee?.phone || '',
    role: employee?.role || ROLES.OFFICER,
    status: employee?.status || 'active',
    hireDate: employee?.hire_date || '',
    licenseNumber: employee?.license_number || '',
    licenseType: employee?.license_type || '',
    licenseExpiresOn: employee?.license_expires_on || '',
    emergencyContactName: employee?.emergency_contact_name || '',
    emergencyContactPhone: employee?.emergency_contact_phone || '',
    defaultSiteId: employee?.default_site_id ? String(employee.default_site_id) : '',
    payRate: employee?.pay_rate_cents != null ? String(employee.pay_rate_cents / 100) : '',
    notes: employee?.notes || '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const payload = {
        ...form,
        defaultSiteId: form.defaultSiteId ? Number(form.defaultSiteId) : null,
        payRate: form.payRate === '' ? null : Number(form.payRate),
        employeeCode: form.employeeCode || undefined,
        hireDate: form.hireDate || null,
        licenseExpiresOn: form.licenseExpiresOn || null,
      };
      const res = editing
        ? await api.patch(`/admin/employees/${employee.id}`, payload)
        : await api.post('/admin/employees', payload);
      toast.success(editing ? 'Employee updated.' : 'Employee added.');
      onSaved(res.credentials || null);
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${employee.full_name}` : 'Add employee'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {editing ? 'Save changes' : 'Create and generate PIN'}
          </button>
        </>
      }
    >
      <div className="stack">
        {!editing && (
          <Banner kind="info">
            A 4-digit PIN is generated automatically. Leave the employee code blank and the next free code is assigned.
          </Banner>
        )}

        <div className="grid grid-2">
          <Field label="First name" error={errors.firstName} required>
            <input value={form.firstName} onChange={set('firstName')} aria-invalid={!!errors.firstName} />
          </Field>
          <Field label="Last name" error={errors.lastName} required>
            <input value={form.lastName} onChange={set('lastName')} aria-invalid={!!errors.lastName} />
          </Field>
        </div>

        <div className="grid grid-3">
          <Field label="Employee code" error={errors.employeeCode} hint={editing ? undefined : 'Auto if blank'}>
            <input
              value={form.employeeCode}
              onChange={(e) => setForm((f) => ({ ...f, employeeCode: e.target.value.replace(/\D/g, '') }))}
              maxLength={6}
              placeholder="1008"
            />
          </Field>
          <Field label="Role">
            <select value={form.role} onChange={set('role')}>
              {Object.values(ROLES).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={set('status')}>
              {EMPLOYEE_STATUS.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="Phone">
            <input type="tel" value={form.phone} onChange={set('phone')} placeholder="(904) 555-0100" />
          </Field>
          <Field label="Email" error={errors.email}>
            <input type="email" value={form.email} onChange={set('email')} aria-invalid={!!errors.email} />
          </Field>
        </div>

        <fieldset>
          <legend>Licensing</legend>
          <div className="grid grid-3">
            <Field label="Licence type">
              <input value={form.licenseType} onChange={set('licenseType')} placeholder="Class D" />
            </Field>
            <Field label="Licence number">
              <input value={form.licenseNumber} onChange={set('licenseNumber')} placeholder="D-0000000" />
            </Field>
            <Field label="Expires">
              <input type="date" value={form.licenseExpiresOn || ''} onChange={set('licenseExpiresOn')} />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Assignment &amp; pay</legend>
          <div className="grid grid-3">
            <Field label="Home site">
              <select value={form.defaultSiteId} onChange={set('defaultSiteId')}>
                <option value="">None</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pay rate ($/hr)">
              <input type="number" step="0.25" min="0" value={form.payRate} onChange={set('payRate')} />
            </Field>
            <Field label="Hire date">
              <input type="date" value={form.hireDate || ''} onChange={set('hireDate')} />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Emergency contact</legend>
          <div className="grid grid-2">
            <Field label="Name">
              <input value={form.emergencyContactName} onChange={set('emergencyContactName')} />
            </Field>
            <Field label="Phone">
              <input type="tel" value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} />
            </Field>
          </div>
        </fieldset>

        <Field label="Internal notes" hint="Not visible to the officer.">
          <textarea value={form.notes} onChange={set('notes')} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- page -- */

export default function EmployeesPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [employees, setEmployees] = useState(null);
  const [sites, setSites] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [dialog, setDialog] = useState(null);
  const [credentials, setCredentials] = useState(null);

  const load = async () => {
    try {
      const [e, s] = await Promise.all([api.get('/admin/employees'), api.get('/admin/sites')]);
      setEmployees(e.employees);
      setSites(s.sites);
    } catch (err) {
      toast.error(err.message);
      setEmployees([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!employees) return [];
    const q = search.trim().toLowerCase();
    return employees.filter(
      (e) =>
        (status === 'all' || e.status === status) &&
        (!q ||
          e.full_name.toLowerCase().includes(q) ||
          e.employee_code.includes(q) ||
          (e.email || '').toLowerCase().includes(q))
    );
  }, [employees, search, status]);

  const resetPin = async (employee) => {
    try {
      const res = await api.post(`/admin/employees/${employee.id}/reset-pin`, {});
      setCredentials(res);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const unlock = async (employee) => {
    try {
      await api.post(`/admin/employees/${employee.id}/unlock`, {});
      toast.success(`${employee.full_name} unlocked.`);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!employees) return <LoadingPage label="Loading employees" />;

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Workforce</div>
          <h1>Employees</h1>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setDialog({ employee: null })}>
            <Icon name="plus" size={17} /> Add employee
          </button>
        )}
      </div>

      <div className="row-between wrap">
        <div className="row grow" style={{ maxWidth: 340 }}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code or email"
          />
        </div>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'suspended', label: 'Suspended' },
            { value: 'terminated', label: 'Former' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <Empty icon="users" title="No employees match" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Home site</th>
                  <th className="num">Week</th>
                  <th>Licence</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const licenseSoon =
                    e.license_expires_on && new Date(e.license_expires_on) < new Date(Date.now() + 60 * 86400000);
                  return (
                    <tr key={e.id}>
                      <td className="mono strong">{e.employee_code}</td>
                      <td>
                        <Link to={`/admin/employees/${e.id}`} className="strong">
                          {e.full_name}
                        </Link>
                        <div className="tiny muted">{e.phone || e.email || '--'}</div>
                      </td>
                      <td className="small">{ROLE_LABEL[e.role]}</td>
                      <td className="small muted">{e.default_site_name || '--'}</td>
                      <td className="num">{e.week_hours}</td>
                      <td className="small">
                        {e.license_number ? (
                          <>
                            {e.license_type}
                            <div className={`tiny ${licenseSoon ? '' : 'muted'}`} style={licenseSoon ? { color: 'var(--warn)' } : undefined}>
                              {licenseSoon ? 'Expires ' : ''}
                              {fmtDate(e.license_expires_on)}
                            </div>
                          </>
                        ) : (
                          <span className="muted">--</span>
                        )}
                      </td>
                      <td>
                        <div className="row wrap" style={{ gap: 5 }}>
                          <StatusChip value={e.status} />
                          {e.on_duty && <Chip kind="ok" dot>On post</Chip>}
                          {e.locked && <Chip kind="danger">Locked</Chip>}
                          {Boolean(e.must_change_pin) && <Chip kind="warn">New PIN</Chip>}
                          {e.open_flags > 0 && <Chip kind="warn">{e.open_flags} flags</Chip>}
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          {e.locked && (
                            <button className="btn btn-sm btn-ghost" onClick={() => unlock(e)}>
                              Unlock
                            </button>
                          )}
                          {isAdmin && (
                            <>
                              <button className="btn btn-sm btn-ghost" onClick={() => resetPin(e)} title="Issue a new PIN">
                                Reset PIN
                              </button>
                              <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ employee: e })}>
                                Edit
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog && (
        <EmployeeDialog
          employee={dialog.employee}
          sites={sites}
          onClose={() => setDialog(null)}
          onSaved={(creds) => {
            setDialog(null);
            if (creds) setCredentials(creds);
            load();
          }}
        />
      )}
      {credentials && <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />}
    </div>
  );
}
