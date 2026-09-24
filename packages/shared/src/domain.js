/**
 * Shared domain vocabulary + business rules for USA Security Connect.
 * Kept dependency-free so the API, the web app and the Expo app can all import it.
 */

export const ROLES = {
  OFFICER: 'officer',
  SUPERVISOR: 'supervisor',
  ADMIN: 'admin',
};

export const ROLE_LABEL = {
  officer: 'Security Officer',
  supervisor: 'Field Supervisor',
  admin: 'Administrator',
};

/** Supervisors inherit every officer permission; admins inherit everything. */
export const ROLE_RANK = { officer: 1, supervisor: 2, admin: 3 };
export const atLeast = (role, required) => (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[required] ?? 99);

export const EMPLOYEE_STATUS = ['active', 'suspended', 'terminated', 'on_leave', 'applicant'];

export const EMPLOYEE_STATUS_LABEL = {
  active: 'Active',
  suspended: 'Suspended',
  terminated: 'Former',
  on_leave: 'On leave',
  applicant: 'Applicant',
};

/* ------------------------------------------------------- employment --- */

/**
 * W2 employees are owed FLSA overtime; 1099 contractors are not, and are paid
 * against an invoice instead. The distinction changes payroll maths, which
 * fields are required, and what the export looks like - so it is modelled
 * explicitly rather than left as a note.
 */
export const EMPLOYMENT_TYPES = ['w2', '1099'];

export const EMPLOYMENT_LABEL = {
  w2: 'W-2 employee',
  '1099': '1099 contractor',
};

export const PAY_TYPES = ['hourly', 'salary', 'per_shift'];

export const PAY_TYPE_LABEL = {
  hourly: 'Hourly',
  salary: 'Salary',
  per_shift: 'Per shift',
};

export const CERTIFICATION_TYPES = [
  'Class D Security Licence',
  'Class G Statewide Firearm Licence',
  'CPR / First Aid',
  'AED',
  'Driver Licence',
  'Defensive Tactics',
  'Verbal De-escalation',
  'Fire Watch',
  'OSHA 10',
  'Other',
];

export const TIME_OFF_TYPES = ['vacation', 'sick', 'unpaid', 'bereavement', 'other'];

export const TIME_OFF_LABEL = {
  vacation: 'Vacation',
  sick: 'Sick',
  unpaid: 'Unpaid',
  bereavement: 'Bereavement',
  other: 'Other',
};

export const UNIFORM_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

export const WEEKDAYS = [
  { value: 1, label: 'Mon', long: 'Monday' },
  { value: 2, label: 'Tue', long: 'Tuesday' },
  { value: 3, label: 'Wed', long: 'Wednesday' },
  { value: 4, label: 'Thu', long: 'Thursday' },
  { value: 5, label: 'Fri', long: 'Friday' },
  { value: 6, label: 'Sat', long: 'Saturday' },
  { value: 0, label: 'Sun', long: 'Sunday' },
];

/** Break types. Florida follows the federal rule: meal breaks over 30 min are unpaid. */
export const BREAK_TYPES = ['meal', 'rest'];

/* --------------------------------------------------- shift requests --- */

export const SHIFT_REQUEST_KINDS = ['claim', 'swap', 'drop'];

export const SHIFT_REQUEST_LABEL = {
  claim: 'Open shift claim',
  swap: 'Shift swap',
  drop: 'Drop request',
};

/**
 * Statuses a request moves through.
 *
 * A swap needs two yeses: the other officer accepts, then a supervisor
 * approves. A claim or drop only needs the supervisor.
 */
export const SHIFT_REQUEST_STATUS = [
  'pending',   // waiting on the other officer (swap) or a supervisor
  'accepted',  // the other officer agreed; now waiting on a supervisor
  'declined',  // the other officer said no
  'approved',
  'denied',
  'cancelled', // withdrawn by the requester
];

/**
 * Why an officer may not take a given shift.
 *
 * Returned as a list so the UI can show every reason at once rather than
 * making someone fix them one at a time. An empty list means eligible.
 */
export function shiftEligibility({ post, officer, certifications = [], conflicts = [], timeOff = [], availability = null }) {
  const reasons = [];

  if (officer?.status !== 'active') {
    reasons.push({ code: 'inactive', message: 'The officer is not active.' });
  }

  // An armed post needs a current Class G. This is the rule that actually
  // matters: working one on a lapsed licence is a licensing violation.
  if (post?.armed) {
    const armedLicence = [
      ...certifications.map((c) => ({ type: c.type, expires: c.expires_on })),
      { type: officer?.license_type, expires: officer?.license_expires_on },
    ].find((c) => /class g|firearm/i.test(c.type || ''));

    if (!armedLicence) {
      reasons.push({ code: 'no_armed_licence', message: 'Armed post: no Class G licence on file.' });
    } else if (armedLicence.expires && expiryState(armedLicence.expires).state === 'expired') {
      reasons.push({ code: 'expired_armed_licence', message: 'Armed post: their Class G licence has expired.' });
    }
  }

  if (officer?.license_expires_on && expiryState(officer.license_expires_on).state === 'expired') {
    reasons.push({ code: 'expired_licence', message: 'Their security licence has expired.' });
  }

  if (conflicts.length) {
    reasons.push({ code: 'conflict', message: 'They already have a shift overlapping this one.' });
  }

  if (timeOff.length) {
    reasons.push({ code: 'time_off', message: 'They have approved time off covering this date.' });
  }

  // Availability is advisory: officers pick up shifts outside their stated
  // hours all the time, so this warns rather than blocks.
  if (availability && availability.available === false) {
    reasons.push({
      code: 'unavailable',
      message: 'Outside the hours they said they can work.',
      advisory: true,
    });
  }

  return reasons;
}

/** Only non-advisory reasons actually prevent an assignment. */
export const blocksAssignment = (reasons = []) => reasons.some((r) => !r.advisory);

export const PANIC_STATUS = ['active', 'acknowledged', 'resolved', 'false_alarm'];

export const INCIDENT_CATEGORIES = [
  'Access Control',
  'Alarm / System',
  'Disturbance',
  'Fire / Life Safety',
  'Injury / Medical',
  'Maintenance Issue',
  'Parking Violation',
  'Property Damage',
  'Suspicious Activity',
  'Theft',
  'Trespass',
  'Vehicle Incident',
  'Other',
];

export const INCIDENT_SEVERITY = ['low', 'medium', 'high', 'critical'];
export const INCIDENT_STATUS = ['submitted', 'under_review', 'closed'];

export const FLAG_TYPES = {
  LATE_CLOCK_IN: 'late_clock_in',
  MISSED_CLOCK_OUT: 'missed_clock_out',
  MISSED_CHECK_IN: 'missed_check_in',
  GEOFENCE_VIOLATION: 'geofence_violation',
  EARLY_DEPARTURE: 'early_departure',
  NO_SHOW: 'no_show',
  UNSCHEDULED_SHIFT: 'unscheduled_shift',
};

export const FLAG_LABEL = {
  late_clock_in: 'Late clock-in',
  missed_clock_out: 'Missed clock-out',
  missed_check_in: 'Missed status check-in',
  geofence_violation: 'Clocked in outside geofence',
  early_departure: 'Left post early',
  no_show: 'No show',
  unscheduled_shift: 'Unscheduled shift',
};

export const FLAG_SEVERITY = {
  late_clock_in: 'warning',
  missed_clock_out: 'warning',
  missed_check_in: 'critical',
  geofence_violation: 'critical',
  early_departure: 'warning',
  no_show: 'critical',
  unscheduled_shift: 'info',
};

/** Compliance thresholds. Overridable per-post in the posts table. */
export const RULES = {
  /** Grace period before a clock-in counts as late. */
  lateGraceMinutes: 7,
  /** How early an officer may clock in before their shift starts. */
  earlyClockInMinutes: 30,
  /** Leaving more than this many minutes early is flagged. */
  earlyDepartureMinutes: 10,
  /** A shift with no clock-in this long after start is a no-show. */
  noShowMinutes: 30,
  /** Default cadence for on-post status check-ins. */
  defaultCheckInIntervalMinutes: 60,
  /** Window an officer has to answer a status check-in before it is missed. */
  checkInWindowMinutes: 10,
  /** Shift left open this long past the scheduled end is auto-closed and flagged. */
  autoClockOutAfterMinutes: 120,
  /** Default radius around a post within which GPS clock-in is accepted. */
  defaultGeofenceRadiusM: 150,
  /** Worst GPS accuracy (metres) we still trust for a geofence decision. */
  maxTrustedAccuracyM: 100,
  /** Failed PIN attempts before the account locks. */
  maxPinAttempts: 5,
  lockoutMinutes: 15,
  /** Hours past this in a week count as overtime. */
  overtimeWeeklyHours: 40,
};

export const BROADCAST_PRIORITY = ['normal', 'important', 'urgent'];

/** Great-circle distance in metres. Used for geofence checks on both client + server. */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Decide whether a GPS fix is close enough to a post to allow a clock-in.
 * A poor accuracy reading is not treated as a violation - it is reported as
 * `unverified` so the admin sees it without punishing the officer for bad signal.
 */
export function evaluateGeofence({ lat, lng, accuracy, post }) {
  if (!post || post.latitude == null || post.longitude == null) {
    return { status: 'not_configured', distance: null };
  }
  if (lat == null || lng == null) return { status: 'no_fix', distance: null };
  const radius = post.geofence_radius_m || RULES.defaultGeofenceRadiusM;
  const distance = distanceMeters(lat, lng, post.latitude, post.longitude);
  if (accuracy != null && accuracy > RULES.maxTrustedAccuracyM) {
    return { status: 'unverified', distance, radius, accuracy };
  }
  return { status: distance <= radius ? 'inside' : 'outside', distance, radius, accuracy };
}

/** Minutes between two ISO timestamps (b - a). */
export const minutesBetween = (a, b) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);

/** Format a duration in minutes as "7h 32m". */
export function formatDuration(minutes) {
  if (minutes == null) return '--';
  const sign = minutes < 0 ? '-' : '';
  const m = Math.abs(Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${sign}${h}h ${m % 60}m` : `${sign}${m}m`;
}

/** Hours worked, rounded to 2dp, for payroll display. */
export const toHours = (minutes) => Math.round(((minutes || 0) / 60) * 100) / 100;

/**
 * Split worked minutes in a week into straight time and overtime.
 * Florida follows the federal FLSA 40-hour weekly threshold.
 */
export function splitOvertime(totalMinutes, weeklyThresholdHours = RULES.overtimeWeeklyHours) {
  const threshold = weeklyThresholdHours * 60;
  return {
    regularMinutes: Math.min(totalMinutes, threshold),
    overtimeMinutes: Math.max(0, totalMinutes - threshold),
  };
}

/**
 * What a person is owed for a period, and what the client is billed for it.
 *
 * The employment type drives the maths:
 *  - **W-2** staff are non-exempt by default and earn overtime past 40 hours
 *    in a week, at their multiplier (1.5x unless overridden).
 *  - **1099** contractors are paid their agreed rate for every hour. They are
 *    not owed FLSA overtime, and paying it anyway is one of the signals that
 *    blurs the contractor line, so the calculation deliberately does not.
 *  - **Exempt** W-2 staff (a salaried manager) earn no overtime either.
 *
 * All money is handled in whole cents to avoid float drift, and this is a
 * planning figure - the payroll provider remains the source of truth.
 */
export function computePay({
  minutes,
  employmentType = 'w2',
  payType = 'hourly',
  exempt = false,
  payRateCents,
  billRateCents,
  overtimeMultiplier = 1.5,
  weeklyThresholdHours = RULES.overtimeWeeklyHours,
  salaryCents = null,
  shifts = 0,
}) {
  const earnsOvertime = employmentType === 'w2' && !exempt && payType === 'hourly';

  const { regularMinutes, overtimeMinutes } = earnsOvertime
    ? splitOvertime(minutes, weeklyThresholdHours)
    : { regularMinutes: minutes, overtimeMinutes: 0 };

  let payCents = null;
  if (payType === 'salary' && salaryCents != null) {
    payCents = Math.round(salaryCents);
  } else if (payType === 'per_shift' && payRateCents != null) {
    payCents = Math.round(payRateCents * shifts);
  } else if (payRateCents != null) {
    payCents = Math.round(
      (regularMinutes / 60) * payRateCents +
        (overtimeMinutes / 60) * payRateCents * overtimeMultiplier
    );
  }

  // The client is billed for hours worked at the contract rate, with no
  // overtime uplift unless the contract says otherwise.
  const billCents = billRateCents != null ? Math.round((minutes / 60) * billRateCents) : null;

  return {
    regularMinutes,
    overtimeMinutes,
    earnsOvertime,
    payCents,
    billCents,
    marginCents: billCents != null && payCents != null ? billCents - payCents : null,
    marginPercent:
      billCents && payCents != null && billCents > 0
        ? Math.round(((billCents - payCents) / billCents) * 1000) / 10
        : null,
  };
}

/** Certifications inside this window are "expiring soon" on the dashboard. */
export const EXPIRY_WARNING_DAYS = 60;

export function expiryState(dateString, warningDays = EXPIRY_WARNING_DAYS) {
  if (!dateString) return { state: 'none', days: null };
  const days = Math.ceil((new Date(dateString).getTime() - Date.now()) / 86400000);
  if (days < 0) return { state: 'expired', days };
  if (days <= warningDays) return { state: 'expiring', days };
  return { state: 'valid', days };
}

/** Minutes of unpaid break to deduct from a shift. Meal breaks are unpaid. */
export function unpaidBreakMinutes(breaks = []) {
  return breaks
    .filter((b) => b.type === 'meal' && !b.paid && b.minutes)
    .reduce((total, b) => total + b.minutes, 0);
}

/** Employee codes are 4-6 digits; PINs are 4-6 digits. */
export const isValidEmployeeCode = (code) => /^[0-9]{4,6}$/.test(String(code || '').trim());
export const isValidPin = (pin) => /^[0-9]{4,6}$/.test(String(pin || '').trim());

/** Reject trivially guessable PINs (0000, 1234, 1111, 4321...). */
export function isWeakPin(pin) {
  const s = String(pin || '');
  if (!isValidPin(s)) return true;
  if (/^(.)\1+$/.test(s)) return true;
  const digits = s.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  return ascending || descending;
}

export const INCIDENT_REF_PREFIX = 'USC';

/* ================================================================ company === */

/**
 * What appears at the top of an invoice.
 *
 * Only the name and the state licence number are filled in, because they are
 * the only two facts this project actually knows. The rest is left blank
 * deliberately: an address, a phone number or bank details invented here
 * would be wrong in a way nobody would notice until a client tried to use
 * them. Fill them in before sending a real invoice - every blank field is
 * simply omitted from the document, and the admin console says so.
 */
export const COMPANY = {
  name: 'USA Security & Protection Group',
  licence: 'B 3400341',
  addressLines: [],   // e.g. ['1200 Riverside Ave, Suite 400', 'Jacksonville, FL 32204']
  phone: '',
  email: '',
  website: 'usasecuritygroup.com',
  /** Free text under the totals: how to pay, terms, late fees. */
  paymentTerms: '',
};

/** Which of the above still need filling in before an invoice goes out. */
export const missingCompanyDetails = (company = COMPANY) =>
  [
    company.addressLines?.length ? null : 'address',
    company.phone ? null : 'phone number',
    company.email ? null : 'email address',
    company.paymentTerms ? null : 'payment instructions',
  ].filter(Boolean);

/* ============================================================== invoicing === */

export const INVOICE_STATUS = ['draft', 'sent', 'paid', 'void'];

export const INVOICE_STATUS_LABEL = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  void: 'Void',
};

/**
 * What can follow what.
 *
 * A sent invoice cannot quietly go back to draft - it has left the building
 * and the client has the number. Correct it by voiding and re-issuing.
 */
export const INVOICE_TRANSITIONS = {
  draft: ['sent', 'void'],
  sent: ['paid', 'void'],
  paid: [],
  void: [],
};

export const canTransitionInvoice = (from, to) =>
  (INVOICE_TRANSITIONS[from] || []).includes(to);

/** Money is held in integer cents everywhere; round once, at the line. */
export const amountForMinutes = (minutes, rateCents) =>
  Math.round(((minutes || 0) / 60) * (rateCents || 0));

/**
 * The bill rate that applies to an hour worked.
 *
 * A one-off rate agreed for a particular shift beats the post's standing
 * rate, which in turn beats a rate carried on the officer - the last being
 * the case for a specialist billed out at their own number.
 */
export const effectiveBillRate = ({ shiftRateCents, postRateCents, officerRateCents }) =>
  shiftRateCents ?? postRateCents ?? officerRateCents ?? null;

/**
 * An officer's unpaid meal break is not billable: they were not on post for
 * it and they were not paid for it.
 */
export const billableMinutes = (minutesWorked, unpaidBreakMinutes = 0) =>
  Math.max(0, (minutesWorked || 0) - (unpaidBreakMinutes || 0));

/** Subtotal, tax and total for a set of lines, in cents. */
export function invoiceTotals(lines = [], taxPercent = 0) {
  const subtotalCents = lines.reduce((sum, l) => sum + (l.amount_cents ?? l.amountCents ?? 0), 0);
  const costCents = lines.reduce((sum, l) => sum + (l.cost_cents ?? l.costCents ?? 0), 0);
  const taxCents = Math.round(subtotalCents * ((taxPercent || 0) / 100));
  const totalCents = subtotalCents + taxCents;
  return {
    subtotalCents,
    taxCents,
    totalCents,
    costCents,
    marginCents: subtotalCents - costCents,
    marginPercent: subtotalCents > 0
      ? Math.round(((subtotalCents - costCents) / subtotalCents) * 1000) / 10
      : null,
  };
}

/** Days past due, or null while an invoice is not yet overdue. */
export function daysOverdue(dueOn, status, now = new Date()) {
  if (!dueOn || status !== 'sent') return null;
  const [y, m, d] = String(dueOn).slice(0, 10).split('-').map(Number);
  const due = new Date(y, m - 1, d, 23, 59, 59, 999);
  const days = Math.floor((now - due) / 86400000);
  return days > 0 ? days : null;
}
