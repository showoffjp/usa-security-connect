import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate } from '../../lib/format.js';
import {
  LoadingPage, Empty, Icon, Chip, StatusChip, Modal, Field, Banner, useToast, Segmented,
} from '../../components/ui.jsx';
import EmployeeDialog from '../../components/EmployeeDialog.jsx';
import { ROLE_LABEL, EMPLOYMENT_LABEL, EMPLOYEE_STATUS_LABEL } from '@shared/domain.js';

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
            { value: 'applicant', label: 'Applicants' },
            { value: 'on_leave', label: 'On leave' },
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
                  <th>Type</th>
                  <th className="num">Rate</th>
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
                      <td>
                        <Chip kind={e.employment_type === '1099' ? 'warn' : 'navy'}>
                          {e.employment_type === '1099' ? '1099' : 'W-2'}
                        </Chip>
                        {e.employment_type === '1099' && !e.w9_on_file && (
                          <div className="tiny" style={{ color: 'var(--danger)' }}>No W-9</div>
                        )}
                      </td>
                      <td className="num small">
                        {e.pay_rate_cents != null ? `$${(e.pay_rate_cents / 100).toFixed(2)}` : '--'}
                        {e.bill_rate_cents != null && (
                          <div className="tiny muted">bill ${(e.bill_rate_cents / 100).toFixed(2)}</div>
                        )}
                      </td>
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
