import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtWeekday } from '../../lib/format.js';
import { Banner, Chip, Empty, Field, Icon, LoadingPage, Modal, Segmented, useToast } from '../../components/ui.jsx';

const times = (n) => `${Number(n)}x`;

/** Add a holiday, or change one already on the calendar. */
function HolidayDialog({ holiday, suggestion, limits, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(holiday);
  const [day, setDay] = useState(holiday?.day || suggestion?.day || '');
  const [name, setName] = useState(holiday?.name || suggestion?.name || '');
  const [pay, setPay] = useState(String(holiday?.pay_multiplier ?? 1.5));
  const [bill, setBill] = useState(String(holiday?.bill_multiplier ?? 1.5));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const body = { name: name.trim(), payMultiplier: Number(pay), billMultiplier: Number(bill) };
      const res = editing ? await api.patch(`/holidays/${holiday.id}`, body) : await api.post('/holidays', { ...body, day });
      toast.success(
        res.invoices_covering > 0
          ? `Saved. ${res.invoices_covering} invoice${res.invoices_covering === 1 ? '' : 's'} already sent for that day keep${res.invoices_covering === 1 ? 's' : ''} its figures.`
          : editing
            ? 'Holiday updated.'
            : 'Holiday added.'
      );
      onSaved();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Change ${holiday.name}` : 'Add a holiday'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim() || (!editing && !day)}>
            {editing ? 'Save' : 'Add holiday'}
          </button>
        </>
      }
    >
      <div className="stack">
        {editing ? (
          <dl className="kv">
            <dt>Date</dt>
            <dd>
              {fmtWeekday(holiday.day)}, {fmtDate(holiday.day)}
            </dd>
          </dl>
        ) : (
          <Field label="Date" required error={errors.day} id="holiday-day">
            <input id="holiday-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        )}
        <Field label="Name" required error={errors.name} id="holiday-name">
          <input id="holiday-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Christmas Eve" />
        </Field>
        <div className="grid grid-2">
          <Field label="Pays" hint="W-2 officers who earn overtime" error={errors.payMultiplier} id="holiday-pay">
            <input id="holiday-pay" type="number" inputMode="decimal" step="0.25" min={limits.min} max={limits.max} value={pay}
              onChange={(e) => setPay(e.target.value)} />
          </Field>
          <Field label="Bills" hint="Times the post's bill rate" error={errors.billMultiplier} id="holiday-bill">
            <input id="holiday-bill" type="number" inputMode="decimal" step="0.25" min={limits.min} max={limits.max} value={bill}
              onChange={(e) => setBill(e.target.value)} />
          </Field>
        </div>
        <p className="tiny muted" style={{ margin: 0 }}>
          A shift counts when it starts on the holiday. Holiday hours that are also overtime get the larger premium, not both.
        </p>
      </div>
    </Modal>
  );
}

/**
 * The company holiday calendar: the days that pay officers a premium and bill
 * clients the holiday rate. Administrators keep it; supervisors read it.
 */
export default function HolidaysPage() {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState(null);
  const [dialog, setDialog] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/holidays?year=${year}`));
    } catch (err) {
      toast.error(err.message);
    }
  }, [year, toast]);
  useEffect(() => {
    load();
  }, [load]);

  const addStandard = async () => {
    try {
      const res = await api.post('/holidays/standard', { year });
      toast.success(
        res.added.length
          ? `Added ${res.added.length} holiday${res.added.length === 1 ? '' : 's'}.${res.skipped.length ? ` ${res.skipped.length} skipped: their pay period is closed.` : ''}`
          : 'The standard holidays are already on the calendar.'
      );
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const remove = async (h) => {
    if (!window.confirm(`Remove ${h.name}? Hours that day go back to the usual pay and bill rates.`)) return;
    try {
      const res = await api.del(`/holidays/${h.id}`);
      toast.success(res.invoices_covering ? `Removed. Invoices already sent for that day keep their figures.` : 'Holiday removed.');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const coreMissing = data?.suggestions.filter((s) => s.core) || [];

  return (
    <div className="page stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow">Workforce</div>
        <h1>Holidays</h1>
        <p className="lead">
          The days that pay officers a premium and bill clients the holiday rate. A shift counts when it starts on one; payroll, timesheets
          and invoices all read this calendar.
        </p>
      </div>

      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <Segmented
          label="Year"
          value={String(year)}
          onChange={(v) => {
            setData(null);
            setYear(Number(v));
          }}
          options={[
            { value: String(thisYear), label: String(thisYear) },
            { value: String(thisYear + 1), label: String(thisYear + 1) },
          ]}
        />
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setDialog({})}>
            <Icon name="plus" size={16} /> Add a holiday
          </button>
        )}
      </div>

      {!data ? (
        <LoadingPage label="Reading the calendar" />
      ) : (
        <>
          {isAdmin && coreMissing.length > 0 && (
            <Banner
              kind="info"
              title={`${coreMissing.length} of the usual holidays ${coreMissing.length === 1 ? 'is' : 'are'} not on ${year}'s calendar`}
              action={
                <button className="btn btn-sm btn-primary" onClick={addStandard}>
                  Add {coreMissing.length === 1 ? 'it' : 'them'}
                </button>
              }
            >
              {coreMissing.map((s) => s.name).join(', ')}. Added at time and a half to pay and to bill.
            </Banner>
          )}

          <div className="card">
            <div className="card-head">
              <h3>{year}</h3>
              <span className="tiny muted">
                {data.holidays.length} holiday{data.holidays.length === 1 ? '' : 's'}
              </span>
            </div>
            {data.holidays.length === 0 ? (
              <Empty icon="calendar" title="No holidays this year">
                Hours are paid and billed at the usual rates every day.
              </Empty>
            ) : (
              <div className="list">
                {data.holidays.map((h) => (
                  <div key={h.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start', opacity: h.past ? 0.75 : 1 }}>
                    <div className="grow">
                      <div className="strong">{h.name}</div>
                      <div className="small muted">
                        {fmtWeekday(h.day)}, {fmtDate(h.day)}
                      </div>
                      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <Chip kind="ok">Pays {times(h.pay_multiplier)}</Chip>
                        <Chip kind="info">Bills {times(h.bill_multiplier)}</Chip>
                        {h.locked ? <Chip>Paid: period closed</Chip> : h.past ? <Chip>Past</Chip> : null}
                      </div>
                    </div>
                    {isAdmin && (
                      <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ holiday: h })} aria-label={`Change ${h.name}`}>
                          Change
                        </button>
                        {!h.locked && (
                          <button className="btn btn-ghost btn-sm" onClick={() => remove(h)} aria-label={`Remove ${h.name}`}>
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.suggestions.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Other federal holidays</h3>
              </div>
              <p className="small muted" style={{ margin: 0, padding: '12px 18px 0' }}>
                Not on the calendar. Some contracts, such as banks and government buildings, treat them as holidays too.
              </p>
              <div className="list">
                {data.suggestions.map((s) => (
                  <div key={s.day} className="list-item" style={{ cursor: 'default' }}>
                    <div className="grow">
                      <div className="small strong">{s.name}</div>
                      <div className="tiny muted">
                        {fmtWeekday(s.day)}, {fmtDate(s.day)}
                      </div>
                    </div>
                    {isAdmin && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ suggestion: s })} aria-label={`Add ${s.name}`}>
                        Add
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {dialog && (
        <HolidayDialog
          holiday={dialog.holiday}
          suggestion={dialog.suggestion}
          limits={data?.limits || { min: 1, max: 3 }}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            load();
          }}
        />
      )}
    </div>
  );
}
