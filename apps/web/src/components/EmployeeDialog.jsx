import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Modal, Field, Banner, Chip, Icon, Segmented, useToast } from './ui.jsx';
import {
  ROLES,
  ROLE_LABEL,
  EMPLOYEE_STATUS,
  EMPLOYEE_STATUS_LABEL,
  EMPLOYMENT_TYPES,
  EMPLOYMENT_LABEL,
  PAY_TYPES,
  PAY_TYPE_LABEL,
  UNIFORM_SIZES,
  WEEKDAYS,
  computePay,
} from '@shared/domain.js';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

const blank = {
  firstName: '', lastName: '', employeeCode: '', email: '', phone: '',
  role: ROLES.OFFICER, status: 'active', hireDate: '',
  licenseNumber: '', licenseType: '', licenseExpiresOn: '',
  emergencyContactName: '', emergencyContactPhone: '', emergencyContactRelation: '',
  defaultSiteId: '', notes: '',
  employmentType: 'w2', payType: 'hourly', exempt: false,
  payRate: '', salary: '', billRate: '', overtimeMultiplier: 1.5,
  businessName: '', taxIdLast4: '', w9OnFile: false,
  contractorAgreementOnFile: false, insuranceExpiresOn: '',
  addressLine1: '', addressLine2: '', city: '', state: 'FL', postalCode: '', uniformSize: '',
};

function fromEmployee(e) {
  if (!e) return blank;
  const money = (cents) => (cents != null ? String(cents / 100) : '');
  return {
    ...blank,
    firstName: e.first_name || '',
    lastName: e.last_name || '',
    employeeCode: e.employee_code || '',
    email: e.email || '',
    phone: e.phone || '',
    role: e.role || ROLES.OFFICER,
    status: e.status || 'active',
    hireDate: e.hire_date || '',
    licenseNumber: e.license_number || '',
    licenseType: e.license_type || '',
    licenseExpiresOn: e.license_expires_on || '',
    emergencyContactName: e.emergency_contact_name || '',
    emergencyContactPhone: e.emergency_contact_phone || '',
    emergencyContactRelation: e.emergency_contact_relation || '',
    defaultSiteId: e.default_site_id ? String(e.default_site_id) : '',
    notes: e.notes || '',
    employmentType: e.employment_type || 'w2',
    payType: e.pay_type || 'hourly',
    exempt: Boolean(e.exempt),
    payRate: money(e.pay_rate_cents),
    salary: money(e.salary_cents),
    billRate: money(e.bill_rate_cents),
    overtimeMultiplier: e.overtime_multiplier ?? 1.5,
    businessName: e.business_name || '',
    taxIdLast4: e.tax_id_last4 || '',
    w9OnFile: Boolean(e.w9_on_file),
    contractorAgreementOnFile: Boolean(e.contractor_agreement_on_file),
    insuranceExpiresOn: e.insurance_expires_on || '',
    addressLine1: e.address_line1 || '',
    addressLine2: e.address_line2 || '',
    city: e.city || '',
    state: e.state || 'FL',
    postalCode: e.postal_code || '',
    uniformSize: e.uniform_size || '',
  };
}

/** Live preview of a 40-hour week, so the pay setup is not guesswork. */
function PayPreview({ form }) {
  const preview = useMemo(() => {
    const toCents = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));
    return computePay({
      minutes: 45 * 60, // a 45-hour week shows whether overtime kicks in
      employmentType: form.employmentType,
      payType: form.payType,
      exempt: form.exempt,
      payRateCents: toCents(form.payRate),
      billRateCents: toCents(form.billRate),
      overtimeMultiplier: Number(form.overtimeMultiplier) || 1.5,
      salaryCents: toCents(form.salary),
      shifts: 5,
    });
  }, [form]);

  const money = (cents) => (cents == null ? '--' : `$${(cents / 100).toFixed(2)}`);

  return (
    <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
      <div className="tiny muted" style={{ fontWeight: 800, letterSpacing: '0.06em', marginBottom: 8 }}>
        EXAMPLE 45-HOUR WEEK
      </div>
      <dl className="kv">
        <dt>Straight time</dt>
        <dd>{(preview.regularMinutes / 60).toFixed(2)}h</dd>
        <dt>Overtime</dt>
        <dd>
          {(preview.overtimeMinutes / 60).toFixed(2)}h{' '}
          {!preview.earnsOvertime && (
            <Chip kind="info">
              {form.employmentType === '1099' ? 'Contractors are not owed FLSA overtime' : 'Exempt - no overtime'}
            </Chip>
          )}
        </dd>
        <dt>Estimated pay</dt>
        <dd className="strong">{money(preview.payCents)}</dd>
        {preview.billCents != null && (
          <>
            <dt>Client billed</dt>
            <dd>{money(preview.billCents)}</dd>
            <dt>Margin</dt>
            <dd
              className="strong"
              style={{ color: preview.marginCents >= 0 ? 'var(--ok)' : 'var(--danger)' }}
            >
              {money(preview.marginCents)}
              {preview.marginPercent != null ? ` (${preview.marginPercent}%)` : ''}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export default function EmployeeDialog({ employee, sites, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(employee);
  const [tab, setTab] = useState('profile');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => fromEmployee(employee));

  const set = (key) => (e) => {
    const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const isContractor = form.employmentType === '1099';

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const num = (v) => (v === '' || v == null ? null : Number(v));
      const payload = {
        ...form,
        defaultSiteId: form.defaultSiteId ? Number(form.defaultSiteId) : null,
        payRate: num(form.payRate),
        salary: num(form.salary),
        billRate: num(form.billRate),
        overtimeMultiplier: Number(form.overtimeMultiplier) || 1.5,
        employeeCode: form.employeeCode || undefined,
        hireDate: form.hireDate || null,
        licenseExpiresOn: form.licenseExpiresOn || null,
        insuranceExpiresOn: form.insuranceExpiresOn || null,
      };
      const res = editing
        ? await api.patch(`/admin/employees/${employee.id}`, payload)
        : await api.post('/admin/employees', payload);
      toast.success(editing ? 'Employee updated.' : 'Employee added.');
      onSaved(res.credentials || null);
    } catch (err) {
      const fields = err.fieldErrors || {};
      setErrors(fields);
      // Send the admin to whichever tab actually has the problem.
      if (fields.w9OnFile || fields.taxIdLast4 || fields.exempt) setTab('employment');
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
            A 4-digit PIN is generated automatically and shown once. Leave the employee code blank to
            assign the next free one.
          </Banner>
        )}

        <Segmented
          label="Employee details section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'profile', label: 'Profile' },
            { value: 'employment', label: isContractor ? 'Pay & 1099' : 'Pay & W-2' },
            { value: 'licensing', label: 'Licensing' },
            { value: 'assignment', label: 'Assignment' },
          ]}
        />

        {/* --------------------------------------------------- profile -- */}
        {tab === 'profile' && (
          <div className="stack">
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
                      {EMPLOYEE_STATUS_LABEL[s]}
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
              <legend>Mailing address</legend>
              <div className="stack">
                <Field label="Street">
                  <input value={form.addressLine1} onChange={set('addressLine1')} />
                </Field>
                <Field label="Apt / unit">
                  <input value={form.addressLine2} onChange={set('addressLine2')} />
                </Field>
                <div className="grid grid-3">
                  <Field label="City">
                    <input value={form.city} onChange={set('city')} />
                  </Field>
                  <Field label="State">
                    <select value={form.state} onChange={set('state')}>
                      {US_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="ZIP">
                    <input value={form.postalCode} onChange={set('postalCode')} maxLength={10} />
                  </Field>
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend>Emergency contact</legend>
              <div className="grid grid-3">
                <Field label="Name">
                  <input value={form.emergencyContactName} onChange={set('emergencyContactName')} />
                </Field>
                <Field label="Relationship">
                  <input value={form.emergencyContactRelation} onChange={set('emergencyContactRelation')} placeholder="Spouse" />
                </Field>
                <Field label="Phone">
                  <input type="tel" value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} />
                </Field>
              </div>
            </fieldset>

            <div className="grid grid-2">
              <Field label="Uniform size">
                <select value={form.uniformSize} onChange={set('uniformSize')}>
                  <option value="">Not recorded</option>
                  {UNIFORM_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Hire date">
                <input type="date" value={form.hireDate || ''} onChange={set('hireDate')} />
              </Field>
            </div>

            <Field label="Internal notes" hint="Not visible to the officer.">
              <textarea value={form.notes} onChange={set('notes')} rows={2} />
            </Field>
          </div>
        )}

        {/* ------------------------------------------------ employment -- */}
        {tab === 'employment' && (
          <div className="stack">
            <Field
              label="Worker classification"
              hint="This drives overtime, the payroll export and which paperwork is required."
              error={errors.employmentType}
            >
              <div className="row" style={{ gap: 10 }}>
                {EMPLOYMENT_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`btn ${form.employmentType === t ? 'btn-navy' : 'btn-ghost'}`}
                    onClick={() => setForm((f) => ({ ...f, employmentType: t, exempt: t === '1099' ? false : f.exempt }))}
                  >
                    {EMPLOYMENT_LABEL[t]}
                  </button>
                ))}
              </div>
            </Field>

            <Banner kind={isContractor ? 'warn' : 'info'}>
              {isContractor
                ? 'Contractors invoice for their hours, are not owed FLSA overtime, and control how the work is done. Directing their schedule and methods the way you would an employee is what re-classifies them.'
                : 'W-2 staff are non-exempt by default and earn overtime past 40 hours in a week.'}
            </Banner>

            <div className="grid grid-3">
              <Field label="Pay basis">
                <select value={form.payType} onChange={set('payType')}>
                  {PAY_TYPES.map((p) => (
                    <option key={p} value={p}>
                      {PAY_TYPE_LABEL[p]}
                    </option>
                  ))}
                </select>
              </Field>

              {form.payType === 'salary' ? (
                <Field label="Salary ($/period)" error={errors.salary}>
                  <input type="number" step="0.01" min="0" value={form.salary} onChange={set('salary')} />
                </Field>
              ) : (
                <Field
                  label={form.payType === 'per_shift' ? 'Rate ($/shift)' : 'Pay rate ($/hr)'}
                  error={errors.payRate}
                >
                  <input type="number" step="0.25" min="0" value={form.payRate} onChange={set('payRate')} />
                </Field>
              )}

              <Field label="Bill rate ($/hr)" hint="What the client pays." error={errors.billRate}>
                <input type="number" step="0.25" min="0" value={form.billRate} onChange={set('billRate')} />
              </Field>
            </div>

            {!isContractor && (
              <div className="grid grid-2">
                <Field label="Overtime multiplier" hint="1.5 is the federal default.">
                  <input
                    type="number"
                    step="0.1"
                    min="1"
                    max="3"
                    value={form.overtimeMultiplier}
                    onChange={set('overtimeMultiplier')}
                  />
                </Field>
                <Field label="FLSA status" error={errors.exempt}>
                  <label className="check" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={form.exempt} onChange={set('exempt')} />
                    <span>
                      Exempt from overtime
                      <div className="tiny muted">Salaried managers only - rarely correct for officers.</div>
                    </span>
                  </label>
                </Field>
              </div>
            )}

            {isContractor && (
              <fieldset>
                <legend>Contractor paperwork</legend>
                <div className="stack">
                  <div className="grid grid-2">
                    <Field label="Business name" hint="If they invoice through an entity.">
                      <input value={form.businessName} onChange={set('businessName')} />
                    </Field>
                    <Field
                      label="Tax ID (last 4)"
                      error={errors.taxIdLast4}
                      hint="Last four digits only. The full EIN or SSN belongs in payroll, not here."
                    >
                      <input
                        value={form.taxIdLast4}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, taxIdLast4: e.target.value.replace(/\D/g, '').slice(0, 4) }))
                        }
                        maxLength={4}
                        placeholder="4821"
                        aria-invalid={!!errors.taxIdLast4}
                      />
                    </Field>
                  </div>

                  <label className="check">
                    <input type="checkbox" checked={form.w9OnFile} onChange={set('w9OnFile')} />
                    <span>
                      Form W-9 on file
                      {errors.w9OnFile && <div className="error">{errors.w9OnFile}</div>}
                    </span>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={form.contractorAgreementOnFile}
                      onChange={set('contractorAgreementOnFile')}
                    />
                    <span>Signed independent contractor agreement on file</span>
                  </label>

                  <Field label="Certificate of insurance expires" hint="Alerts appear 60 days out.">
                    <input type="date" value={form.insuranceExpiresOn || ''} onChange={set('insuranceExpiresOn')} />
                  </Field>
                </div>
              </fieldset>
            )}

            <PayPreview form={form} />
          </div>
        )}

        {/* ------------------------------------------------- licensing -- */}
        {tab === 'licensing' && (
          <div className="stack">
            <Banner kind="info">
              This is the primary state licence. Add CPR, firearms and other certifications from the
              employee's own page once they are created.
            </Banner>
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
          </div>
        )}

        {/* ------------------------------------------------ assignment -- */}
        {tab === 'assignment' && (
          <div className="stack">
            <Field label="Home site" hint="Used as the default when they clock in without a scheduled shift.">
              <select value={form.defaultSiteId} onChange={set('defaultSiteId')}>
                <option value="">None</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>

            <Banner kind="info" title="Availability and time off">
              Set weekly availability and approve time off from the employee's own page after saving.
              Scheduling warns before assigning a shift outside those hours.
            </Banner>

            <div className="card card-pad">
              <div className="tiny muted" style={{ fontWeight: 800, letterSpacing: '0.06em', marginBottom: 8 }}>
                DEFAULT WEEKLY AVAILABILITY
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {WEEKDAYS.map((d) => (
                  <Chip key={d.value} kind="navy">
                    {d.label}
                  </Chip>
                ))}
              </div>
              <div className="tiny muted" style={{ marginTop: 8 }}>
                New employees start fully available. Narrow it on their page.
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
