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
 * Where sites and posts are. Each pin is compared with its street address as
 * a geocoder finds it. A match on the building itself should be within
 * `pinToleranceM` (about 400 ft); a match only placed along the street (US
 * Census address ranges) can be a few hundred metres out on a big property,
 * so it is judged to `streetToleranceM`. Past three times the tolerance a pin
 * is taken to be wrong. A post with no address of its own should be on its
 * site's property: within `postFromSiteM` of the site pin. A pin set from a
 * phone standing at the post, with a fix good to `surveyAccuracyM` (about
 * 80 ft), is trusted over any address.
 */
export const LOCATION_RULES = { pinToleranceM: 120, streetToleranceM: 300, postFromSiteM: 600, surveyAccuracyM: 25, goodFixM: 15, bestFixSeconds: 10 };
export const LOCATION_STATE_LABEL = {
  surveyed: 'Set at the post',
  ok: 'Matches the address',
  check: 'Check the pin',
  wrong: 'Pin is wrong',
  no_pin: 'No pin',
  no_match: 'Address not found',
  unchecked: 'Not checked yet',
};
/** Check-in cadences an administrator picks from, in minutes; 0 is off. */
export const CHECK_IN_CHOICES = [0, 15, 30, 45, 60, 90, 120, 180, 240];
export const checkInLabel = (min) =>
  !min ? 'Off' : min < 60 ? `Every ${min} min` : min === 60 ? 'Every hour' : min % 60 ? `Every ${Math.floor(min / 60)} h ${min % 60} min` : `Every ${min / 60} hours`;

/**
 * Shift offers: an open shift sent to several officers at once. Where one
 * stands, worked out from the offer and its shift together, so an offer
 * whose shift was taken some other way reads as covered on its own.
 */
export const OFFER_STATE_LABEL = {
  open: 'Waiting for a yes',
  filled: 'Taken',
  covered: 'Covered another way',
  withdrawn: 'Withdrawn',
  expired: 'Started with nobody on it',
};
/** At most this many officers are asked about one shift. */
export const OFFER_MAX_RECIPIENTS = 20;
/** With nobody yet saying yes, an offer is raised in the alerts this close to the start. */
export const OFFER_ALERT_HOURS = 3;

/**
 * Why an officer may not take a given shift.
 *
 * Returned as a list so the UI can show every reason at once rather than
 * making someone fix them one at a time. An empty list means eligible.
 */
export function shiftEligibility({ post, officer, certifications = [], conflicts = [], timeOff = [], availability = null, training = null, suspended = false, fatigue = [] }) {
  const reasons = [];

  if (suspended) {
    reasons.push({ code: 'suspended', message: 'They are suspended on this date.', officerMessage: 'You are suspended on this date.' });
  }

  if (officer?.status !== 'active') {
    reasons.push({ code: 'inactive', message: 'The officer is not active.', officerMessage: 'Your account is not active.' });
  }

  // An armed post needs a current Class G. This is the rule that actually
  // matters: working one on a lapsed licence is a licensing violation.
  if (post?.armed) {
    const armedLicence = [
      ...certifications.map((c) => ({ type: c.type, expires: c.expires_on })),
      { type: officer?.license_type, expires: officer?.license_expires_on },
    ].find((c) => /class g|firearm/i.test(c.type || ''));

    if (!armedLicence) {
      reasons.push({ code: 'no_armed_licence', message: 'Armed post: no Class G licence on file.', officerMessage: 'It is an armed post, and there is no Class G licence on file for you.' });
    } else if (armedLicence.expires && expiryState(armedLicence.expires).state === 'expired') {
      reasons.push({ code: 'expired_armed_licence', message: 'Armed post: their Class G licence has expired.', officerMessage: 'It is an armed post, and your Class G licence has expired.' });
    }
  }

  if (officer?.license_expires_on && expiryState(officer.license_expires_on).state === 'expired') {
    reasons.push({ code: 'expired_licence', message: 'Their security licence has expired.', officerMessage: 'Your security licence has expired.' });
  }

  if (conflicts.length) {
    reasons.push({ code: 'conflict', message: 'They already have a shift overlapping this one.', officerMessage: 'You already have a shift at that time.' });
  }

  if (timeOff.length) {
    reasons.push({ code: 'time_off', message: 'They have approved time off covering this date.', officerMessage: 'You have approved time off that day.' });
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

  // Site training: a post that needs it is worked alone only by an officer a
  // supervisor has signed off there. A supervisor may still roster someone
  // new - that is how a training shift gets on the schedule - so it warns
  // them; an officer cannot claim or swap into it themselves.
  if (post?.training_required && training && training !== 'trained') {
    reasons.push(
      training === 'lapsed'
        ? { code: 'training_lapsed', message: `Not worked here in over ${QUALIFICATION_LAPSE_DAYS} days: needs a refresher before working it alone.`, advisory: true, supervisorOnly: true,
            officerMessage: `You have not worked this post in over ${QUALIFICATION_LAPSE_DAYS} days: ask a supervisor for a refresher shift.` }
        : { code: 'not_trained', message: 'Not trained at this post yet: roster it as a training shift, then sign them off.', advisory: true, supervisorOnly: true,
            officerMessage: 'You need site training at this post first: ask a supervisor to put you on a training shift.' }
    );
  }

  // Rest and fatigue (see fatigueIssues): a supervisor can still roster it,
  // with the warning in front of them, but an officer cannot take it on
  // themselves.
  reasons.push(...fatigue);

  return reasons;
}

/** Only non-advisory reasons actually prevent an assignment. */
export const blocksAssignment = (reasons = []) => reasons.some((r) => !r.advisory);

/**
 * What stops an officer taking a shift themselves - claiming it or having it
 * swapped to them - as against a supervisor rostering them: also anything only
 * a supervisor may decide, such as working a post before being trained there.
 */
export const blocksSelfService = (reasons = []) => reasons.some((r) => !r.advisory || r.supervisorOnly);

/* ------------------------------------------------------- rest and fatigue -- */

export const FATIGUE_CODES = ['short_rest', 'long_day', 'too_many_days'];
export const FATIGUE_LABEL = {
  short_rest: 'Short rest',
  long_day: 'Long day',
  too_many_days: 'Too many days in a row',
};

const HOUR_MS = 3600000;
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hoursText = (h) => `${Math.round(h * 10) / 10} h`;

/**
 * Rest and fatigue around one shift, from the officer's other shifts.
 *
 * `others` are their other shifts near it, each with `starts_at` and
 * `ends_at` as worked: a shift they were held over on ends when they clocked
 * out (or now, if they are still on). Shifts that overlap this one are a
 * conflict, not a rest problem, and are left out. Three rules, each from RULES:
 *
 *  - at least minRestHours off between shifts, before and after this one;
 *    working straight on (no gap at all) is a long day instead;
 *  - at most maxHoursPer24 hours of work in any 24 hours;
 *  - at most maxConsecutiveDays days in a row with a shift.
 *
 * Returns eligibility reasons: advisory, so a supervisor can still roster the
 * shift, and supervisorOnly, so an officer cannot claim or swap into it.
 *
 * With `lookBack`, only what leads up to the shift counts: the rest before
 * it, the 24 hours ending when it does, and the days in a row up to it. That
 * is how the fatigue board lists a problem once, on the shift that tips it,
 * rather than on both shifts either side of a short gap.
 */
export function fatigueIssues({ startsAt, endsAt, others = [], rules = RULES, lookBack = false }) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const shifts = others
    .map((o) => ({ start: new Date(o.starts_at).getTime(), end: new Date(o.ends_at).getTime() }))
    .filter((o) => o.end > o.start && (o.end <= start || o.start >= end));
  const issues = [];
  const minRest = rules.minRestHours * HOUR_MS;

  const before = shifts.filter((o) => o.end <= start).sort((a, b) => b.end - a.end)[0];
  const after = shifts.filter((o) => o.start >= end).sort((a, b) => a.start - b.start)[0];
  const restBefore = before ? start - before.end : null;
  const restAfter = after ? after.start - end : null;
  if (restBefore != null && restBefore > 0 && restBefore < minRest) {
    issues.push({
      code: 'short_rest',
      message: `Only ${hoursText(restBefore / HOUR_MS)} off since their last shift ended (${rules.minRestHours} h is the minimum).`,
      officerMessage: `You would have only ${hoursText(restBefore / HOUR_MS)} off before this shift; ${rules.minRestHours} h is the minimum. Ask a supervisor.`,
      note: `Only ${hoursText(restBefore / HOUR_MS)} off before this shift, after your last one.`,
    });
  } else if (!lookBack && restAfter != null && restAfter > 0 && restAfter < minRest) {
    issues.push({
      code: 'short_rest',
      message: `Only ${hoursText(restAfter / HOUR_MS)} off before their next shift (${rules.minRestHours} h is the minimum).`,
      officerMessage: `You would have only ${hoursText(restAfter / HOUR_MS)} off before your next shift; ${rules.minRestHours} h is the minimum. Ask a supervisor.`,
      note: `Only ${hoursText(restAfter / HOUR_MS)} off between this shift and your next.`,
    });
  }

  // The busiest 24 hours that include this shift: every window starting at a
  // shift start, or ending at a shift end, that touches it.
  const all = [...shifts, { start, end }];
  const windows = [];
  if (lookBack) windows.push(end - 24 * HOUR_MS);
  else for (const s of all) windows.push(s.start, s.end - 24 * HOUR_MS);
  let worst = 0;
  for (const w of windows) {
    const wEnd = w + 24 * HOUR_MS;
    if (wEnd <= start || w >= end) continue;
    const worked = all.reduce((sum, s) => sum + Math.max(0, Math.min(s.end, wEnd) - Math.max(s.start, w)), 0);
    worst = Math.max(worst, worked);
  }
  if (worst > rules.maxHoursPer24 * HOUR_MS) {
    issues.push({
      code: 'long_day',
      message: `${hoursText(worst / HOUR_MS)} of work in 24 hours (${rules.maxHoursPer24} h is the most).`,
      officerMessage: `That would be ${hoursText(worst / HOUR_MS)} of work in 24 hours; ${rules.maxHoursPer24} h is the most. Ask a supervisor.`,
      note: `${hoursText(worst / HOUR_MS)} of work in 24 hours.`,
    });
  }

  // Days in a row with a shift, counting this one's start day.
  const days = new Set(all.map((s) => localDay(new Date(s.start))));
  const day = new Date(start);
  day.setHours(12, 0, 0, 0);
  let run = 1;
  for (const step of lookBack ? [-1] : [-1, 1]) {
    const d = new Date(day);
    for (;;) {
      d.setDate(d.getDate() + step);
      if (!days.has(localDay(d))) break;
      run += 1;
    }
  }
  if (run > rules.maxConsecutiveDays) {
    issues.push({
      code: 'too_many_days',
      message: `${run} days in a row (${rules.maxConsecutiveDays} is the most).`,
      officerMessage: `That would be ${run} days in a row; ${rules.maxConsecutiveDays} is the most. Ask a supervisor.`,
      note: `Day ${run} in a row.`,
    });
  }

  return issues.map((i) => ({ ...i, advisory: true, supervisorOnly: true, rest_before_hours: restBefore != null ? restBefore / HOUR_MS : null }));
}

/* ----------------------------------------------------------- site training -- */

/** A post's site training lapses after this long without working it. */
export const QUALIFICATION_LAPSE_DAYS = 180;

/** How an officer learned a post. */
export const TRAINING_METHODS = ['shadow_shift', 'walkthrough', 'prior_experience'];
export const TRAINING_METHOD_LABEL = {
  shadow_shift: 'Shadow shift with a trained officer',
  walkthrough: 'Walkthrough with a supervisor',
  prior_experience: 'Worked the post before',
};

export const TRAINING_STATE_LABEL = {
  trained: 'Trained',
  lapsed: 'Needs a refresher',
  untrained: 'Not trained',
  revoked: 'Withdrawn',
};

/**
 * Where an officer stands at a post: trained; lapsed, when they were trained
 * but have not worked it (or been signed off again) in QUALIFICATION_LAPSE_DAYS;
 * revoked, when a supervisor withdrew it; otherwise untrained.
 */
export function trainingState(qualification, lastWorkedAt = null, now = new Date()) {
  if (!qualification) return 'untrained';
  if (qualification.status === 'revoked') return 'revoked';
  const latest = Math.max(
    new Date(qualification.trained_at).getTime() || 0,
    lastWorkedAt ? new Date(lastWorkedAt).getTime() || 0 : 0
  );
  return now.getTime() - latest > QUALIFICATION_LAPSE_DAYS * 86400000 ? 'lapsed' : 'trained';
}

/* -------------------------------------------------- coaching & discipline -- */

/**
 * The steps of progressive discipline, mildest first. Coaching is a
 * documented conversation, not a warning. A supervisor records the first
 * three; a final warning or a suspension is an administrator's decision.
 */
export const CONDUCT_LEVELS = ['coaching', 'verbal_warning', 'written_warning', 'final_warning', 'suspension'];
export const CONDUCT_LEVEL_LABEL = {
  coaching: 'Coaching',
  verbal_warning: 'Verbal warning',
  written_warning: 'Written warning',
  final_warning: 'Final warning',
  suspension: 'Suspension',
};
export const CONDUCT_ADMIN_LEVELS = ['final_warning', 'suspension'];

export const CONDUCT_CATEGORIES = ['attendance', 'post_conduct', 'uniform', 'procedure', 'client_complaint', 'safety', 'other'];
export const CONDUCT_CATEGORY_LABEL = {
  attendance: 'Attendance and punctuality',
  post_conduct: 'Conduct on post',
  uniform: 'Uniform and appearance',
  procedure: 'Post orders and procedure',
  client_complaint: 'Client complaint',
  safety: 'Safety',
  other: 'Other',
};

/** A record counts towards the next step for this long after it happened. */
export const CONDUCT_ACTIVE_MONTHS = 12;
/** An officer has this long to read and sign a record before it is chased. */
export const CONDUCT_SIGN_DAYS = 3;

/** Whether a record still counts: not rescinded, and within CONDUCT_ACTIVE_MONTHS. */
export function conductActive(record, now = new Date()) {
  if (!record || record.status === 'rescinded') return false;
  const d = new Date(`${String(record.occurred_on).slice(0, 10)}T12:00:00`);
  d.setMonth(d.getMonth() + CONDUCT_ACTIVE_MONTHS);
  return d > now;
}

/**
 * The step a new record about `category` would usually be: one above the
 * highest record still active for the same thing, capped at a final warning.
 * A suspension is never suggested; it is always a deliberate decision.
 */
export function suggestedConductLevel(records = [], category, now = new Date()) {
  const active = records.filter((r) => r.category === category && conductActive(r, now));
  if (!active.length) return 'coaching';
  const top = Math.max(...active.map((r) => CONDUCT_LEVELS.indexOf(r.level)));
  return CONDUCT_LEVELS[Math.min(top + 1, CONDUCT_LEVELS.indexOf('final_warning'))];
}

/* --------------------------------------------------------------- handovers -- */

/** How far ahead the handover board looks at shifts ending. */
export const HANDOVER_WINDOW_MINUTES = 120;

/**
 * Where an on-duty officer's relief stands, worst first. `relieved` means the
 * relief is on post and the officer can hand over and go; `closes` means no
 * shift follows at the post, so there is nobody to hand over to.
 */
export const HANDOVER_STATES = ['late', 'open', 'unconfirmed', 'confirmed', 'relieved', 'closes'];
export const HANDOVER_STATE_LABEL = {
  late: 'Relief late',
  open: 'No relief assigned',
  unconfirmed: 'Relief not confirmed',
  confirmed: 'Relief confirmed',
  relieved: 'Relief on post',
  closes: 'Post closes',
};

/**
 * The state of one handover. `outgoing` is the officer's shift (ends_at),
 * `relief` the shift that follows at the same post (or null), with whether its
 * officer has clocked in and confirmed.
 */
export function handoverState({ outgoing, relief, now = new Date() }) {
  if (!relief) return 'closes';
  if (relief.clocked_in) return 'relieved';
  if (!relief.user_id) return 'open';
  if (now.getTime() > new Date(relief.starts_at).getTime() + RULES.lateGraceMinutes * 60000) return 'late';
  return relief.confirmed ? 'confirmed' : 'unconfirmed';
}

/** How serious a handover is, for sorting and alerts. */
export function handoverSeverity(state, minutesToEnd) {
  if (state === 'late') return 'critical';
  if (state === 'open') return minutesToEnd <= 60 ? 'critical' : 'warning';
  if (state === 'unconfirmed') return minutesToEnd <= 60 ? 'warning' : 'info';
  return 'ok';
}

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

/* ---------------------------------------------------------------- hiring -- */

/** Where an applicant is. Hired and rejected are where an application ends. */
export const HIRING_STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
export const HIRING_STAGE_LABEL = {
  applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Not taken on',
};
/** The board's columns: everyone still in play. */
export const OPEN_HIRING_STAGES = ['applied', 'screening', 'interview', 'offer'];

/**
 * What has to be checked before someone can be put on a post. The required
 * ones block hiring: Florida needs a valid Class D (or G for armed posts)
 * licence, and no client accepts an officer without a background check.
 */
export const HIRING_CHECKS = [
  { key: 'licence', label: 'Security licence verified with FDACS', required: true },
  { key: 'background', label: 'Background check clear', required: true },
  { key: 'right_to_work', label: 'I-9 right to work on file', required: true },
  { key: 'drug_test', label: 'Drug test passed', required: false },
  { key: 'references', label: 'References checked', required: false },
  { key: 'orientation', label: 'Orientation booked', required: false },
];

export const LICENCE_CLASSES = ['none', 'D', 'G', 'DG'];
export const LICENCE_CLASS_LABEL = { none: 'No licence yet', D: 'Class D', G: 'Class G', DG: 'Class D and G' };
export const APPLICANT_SOURCES = ['website', 'referral', 'job_board', 'walk_in', 'other'];
export const APPLICANT_SOURCE_LABEL = { website: 'Website', referral: 'Referral', job_board: 'Job board', walk_in: 'Walk-in', other: 'Other' };

/**
 * What a field supervisor checks on a post visit. Stored as one boolean column
 * each on supervisor_visits, so the keys are the column names.
 */
export const VISIT_CHECKS = [
  { key: 'uniform_ok', label: 'Uniform and appearance' },
  { key: 'post_orders_reviewed', label: 'Post orders reviewed with the officer' },
  { key: 'equipment_ok', label: 'Equipment present and working' },
  { key: 'site_secure', label: 'Site secure' },
];
/** A site with no supervisor visit for this long is due one. */
export const VISIT_DUE_DAYS = 14;

/**
 * Calls for service: something at a property that needs an officer now - an
 * alarm, a suspicious person, a door to unlock. Raised by the office or by a
 * client from the portal, sent to an officer on duty, and timed from the call
 * to the officer arriving.
 */
export const CALL_TYPES = ['alarm', 'suspicious', 'disturbance', 'medical', 'lockout', 'escort', 'parking', 'maintenance', 'other'];
export const CALL_TYPE_LABEL = {
  alarm: 'Alarm', suspicious: 'Suspicious person or activity', disturbance: 'Disturbance', medical: 'Medical',
  lockout: 'Lockout or door', escort: 'Escort', parking: 'Parking problem', maintenance: 'Building problem', other: 'Other',
};
/** 1 is an emergency. Clients can raise 2 and 3; an emergency is a 911 call first. */
export const CALL_PRIORITIES = [1, 2, 3];
export const CALL_PRIORITY_LABEL = { 1: 'Emergency', 2: 'Urgent', 3: 'Routine' };
/** Minutes from the call to an officer on scene that we aim for, by priority. */
export const CALL_TARGET_MINUTES = { 1: 5, 2: 15, 3: 45 };
/** An officer who has not acknowledged a call this long after it was sent to them is chased. */
export const CALL_ACK_MINUTES = 3;
export const CALL_STATUSES = ['open', 'assigned', 'en_route', 'on_scene', 'cleared', 'cancelled'];
export const OPEN_CALL_STATUSES = ['open', 'assigned', 'en_route', 'on_scene'];
export const CALL_STATUS_LABEL = {
  open: 'Waiting for an officer', assigned: 'Sent to an officer', en_route: 'On the way', on_scene: 'On scene',
  cleared: 'Cleared', cancelled: 'Cancelled',
};
export const CALL_DISPOSITIONS = ['resolved', 'nothing_found', 'report', 'police', 'fire_ems', 'referred'];
export const CALL_DISPOSITION_LABEL = {
  resolved: 'Dealt with', nothing_found: 'Nothing found', report: 'Incident report written', police: 'Police called',
  fire_ems: 'Fire or EMS called', referred: 'Passed to the property',
};

/**
 * An officer asking for a punch to be fixed: a forgotten clock-out, a clock-in
 * the app missed. Only recent shifts, and an administrator decides.
 */
export const CORRECTION_WINDOW_DAYS = 14;
export const CORRECTION_STATUSES = ['pending', 'approved', 'declined', 'withdrawn'];
export const CORRECTION_STATUS_LABEL = { pending: 'Waiting for the office', approved: 'Approved', declined: 'Declined', withdrawn: 'Withdrawn' };

/**
 * Shift confirmations: an officer says "I'll be there" for an upcoming shift.
 * A reminder goes out a day before; an unconfirmed shift this close to its
 * start is on the supervisors' list, and urgent once it is closer still.
 */
export const CONFIRM_AHEAD_DAYS = 7;
export const CONFIRM_REMIND_HOURS = 24;
export const CONFIRM_ALERT_HOURS = 12;
export const CONFIRM_URGENT_HOURS = 2;

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
  OFF_POST: 'off_post',
  EQUIPMENT_NOT_RETURNED: 'equipment_not_returned',
  CHECK_IN_AWAY: 'check_in_away',
};

export const FLAG_LABEL = {
  late_clock_in: 'Late clock-in',
  missed_clock_out: 'Missed clock-out',
  missed_check_in: 'Missed status check-in',
  geofence_violation: 'Clocked in outside geofence',
  early_departure: 'Left post early',
  no_show: 'No show',
  unscheduled_shift: 'Unscheduled shift',
  equipment_not_returned: 'Equipment not returned',
  off_post: 'Left the post geofence',
  check_in_away: 'Checked in away from the post',
};

export const FLAG_SEVERITY = {
  equipment_not_returned: 'warning',
  check_in_away: 'warning',
  late_clock_in: 'warning',
  missed_clock_out: 'warning',
  missed_check_in: 'critical',
  geofence_violation: 'critical',
  early_departure: 'warning',
  no_show: 'critical',
  unscheduled_shift: 'info',
  off_post: 'warning',
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
  /** The longest a single shift can be, as recorded or corrected. */
  maxShiftHours: 16,
  /** How often an on-duty device reports its position. */
  locationPingSeconds: 60,
  /** Pings closer together than this are acknowledged but not stored. */
  minPingGapSeconds: 20,
  /** An on-duty officer with no position for this long shows as GPS stale. */
  gpsStaleMinutes: 15,
  /** Location history older than this is deleted by the sweep. */
  locationRetentionDays: 90,
  /** Fewest hours off between one shift ending (as worked) and the next starting. */
  minRestHours: 8,
  /** Most hours worked in any 24 hours. */
  maxHoursPer24: 16,
  /** Most days in a row with a shift. */
  maxConsecutiveDays: 6,
  /** How far ahead of a shift an officer can say they are running late or call off. */
  headsUpHours: 12,
  /** The latest arrival an officer running late can give, in minutes from now. */
  maxEtaMinutes: 180,
  /** A call-off with less than this left before the start is short notice. */
  shortNoticeHours: 4,
};

/**
 * Why an officer cannot work a shift they are on. A call-off opens the shift
 * at once and tells the supervisors; planned changes go through a drop request.
 */
export const CALL_OFF_REASONS = ['sick', 'family', 'transport', 'other'];
export const CALL_OFF_LABEL = {
  sick: 'Sick',
  family: 'Family emergency',
  transport: 'Car or transport trouble',
  other: 'Something else',
};

/**
 * Attendance points: every lapse in the last `windowDays` scores, and an
 * officer on `threshold` or more is flagged for a supervisor to talk to. A
 * late start the officer warned of, arriving by the time they gave, scores
 * nothing: that is what the heads-up is for.
 */
export const ATTENDANCE_POINTS = { windowDays: 30, threshold: 4, noShow: 3, shortCallOff: 2, callOff: 1, late: 1 };

/** The points one item on an attendance record scores. */
export function attendancePointsFor(item) {
  if (item.kind === 'no_show') return ATTENDANCE_POINTS.noShow;
  if (item.kind === 'called_off') return item.short_notice ? ATTENDANCE_POINTS.shortCallOff : ATTENDANCE_POINTS.callOff;
  if (item.kind === 'late') return item.kept_word ? 0 : ATTENDANCE_POINTS.late;
  return 0;
}

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

/** Initial compass bearing from point 1 to point 2, in whole degrees (0 = north). */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassPoint = (degrees) =>
  degrees == null ? null : COMPASS[Math.round(degrees / 45) % 8];

/** "1.2 km" or "340 m" - how far, in the unit a person would say out loud. */
export function formatDistance(meters) {
  if (meters == null) return '--';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

/**
 * Where a person is relative to where they should be.
 *
 * `from` is the officer's actual fix and `to` the assigned post. The bearing
 * is the direction the officer must walk to get back, so the officer app can
 * say "340 m, head NE" rather than just "outside".
 */
export function locationOffset({ lat, lng, accuracy = null, post }) {
  const fence = evaluateGeofence({ lat, lng, accuracy, post });
  if (fence.distance == null) return { ...fence, bearing: null, heading: null };
  const bearing = bearingDegrees(lat, lng, post.latitude, post.longitude);
  return { ...fence, bearing, heading: compassPoint(bearing) };
}

/**
 * The one-word state of an officer on the live board, in priority order: an
 * active duress alert outranks everything, being off post outranks a break,
 * and so on. Kept here so the API and any client agree on the vocabulary.
 */
export const LIVE_STATUS = ['duress', 'off_post', 'no_show', 'late', 'on_break', 'on_post', 'upcoming', 'off_duty'];

export const LIVE_STATUS_LABEL = {
  duress: 'Duress alert',
  off_post: 'Off post',
  no_show: 'No show',
  late: 'Late - not clocked in',
  on_break: 'On break',
  on_post: 'On post',
  upcoming: 'Starting soon',
  off_duty: 'Off duty',
};

export function liveStatus({
  duress = false,
  onDuty = false,
  onBreak = false,
  lastFence = null,
  shiftStartsAt = null,
  now = new Date(),
}) {
  if (duress) return 'duress';
  if (onDuty) {
    if (lastFence === 'outside') return 'off_post';
    return onBreak ? 'on_break' : 'on_post';
  }
  if (shiftStartsAt) {
    const late = minutesBetween(shiftStartsAt, now);
    if (late > RULES.noShowMinutes) return 'no_show';
    if (late > RULES.lateGraceMinutes) return 'late';
    return 'upcoming';
  }
  return 'off_duty';
}

/**
 * The Monday that starts the payroll week containing `date`, as YYYY-MM-DD in
 * local time. Overtime is decided per payroll week, never across a range.
 */
export function payrollWeekOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pay for a period made of whole payroll weeks.
 *
 * `weeks` is the paid minutes in each payroll week. Overtime is worked out
 * week by week - forty hours in each of two weeks is eighty hours of straight
 * time, not forty hours of overtime - which is the mistake a range total makes.
 */
export function computePeriodPay({ weeks = [], shifts = 0, ...person }) {
  const minutes = weeks.reduce((n, m) => n + m, 0);
  if (person.payType === 'salary' || person.payType === 'per_shift') {
    return computePay({ ...person, minutes, shifts });
  }
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  let payCents = person.payRateCents == null ? null : 0;
  let earnsOvertime = false;
  for (const weekMinutes of weeks) {
    const p = computePay({ ...person, minutes: weekMinutes, shifts: 0 });
    regularMinutes += p.regularMinutes;
    overtimeMinutes += p.overtimeMinutes;
    earnsOvertime = p.earnsOvertime;
    if (payCents != null) payCents += p.payCents ?? 0;
  }
  const billCents =
    person.billRateCents != null ? Math.round((minutes / 60) * person.billRateCents) : null;
  return {
    minutes,
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

/* ------------------------------------------------- keys and equipment -- */

export const EQUIPMENT_CATEGORIES = ['radio', 'keys', 'vehicle', 'weapon', 'other'];

export const EQUIPMENT_CATEGORY_LABEL = {
  radio: 'Radio',
  keys: 'Key ring',
  vehicle: 'Vehicle',
  weapon: 'Firearm',
  other: 'Other',
};

export const EQUIPMENT_STATUS = ['available', 'issued', 'maintenance', 'lost', 'retired'];

export const EQUIPMENT_STATUS_LABEL = {
  available: 'Available',
  issued: 'Signed out',
  maintenance: 'In maintenance',
  lost: 'Missing',
  retired: 'Retired',
};

/** The condition noted when an item changes hands, both ways. */
export const EQUIPMENT_CONDITIONS = ['good', 'worn', 'damaged'];

/* ---------------------------------------------------- expense claims -- */

/** What an officer can claim back. Mileage is in their own vehicle, priced per mile. */
export const EXPENSE_CATEGORIES = ['mileage', 'parking', 'tolls', 'supplies', 'meals', 'other'];
export const EXPENSE_CATEGORY_LABEL = {
  mileage: 'Mileage (own vehicle)',
  parking: 'Parking',
  tolls: 'Tolls',
  supplies: 'Supplies',
  meals: 'Meals on a long shift',
  other: 'Other',
};
export const EXPENSE_STATUS_LABEL = {
  pending: 'Waiting',
  approved: 'Approved',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  paid: 'Paid',
};
/** The IRS standard mileage rate, in cents a mile. */
export const MILEAGE_RATE_CENTS = 70;
/** A receipt is needed above this, for anything but mileage. */
export const RECEIPT_REQUIRED_CENTS = 2500;
/** How far back a claim can go, and the most one claim can be for. */
export const EXPENSE_WINDOW_DAYS = 60;
export const EXPENSE_MAX_CENTS = 100000;

/** What a claim comes to: mileage is priced from the miles, everything else is what was spent. */
export function expenseAmountCents({ category, miles, amountCents }) {
  if (category === 'mileage') return Math.round((Number(miles) || 0) * MILEAGE_RATE_CENTS);
  return Math.round(Number(amountCents) || 0);
}

/* ----------------------------------------------------- commendations -- */

/** What an officer can be commended for, by a client or a supervisor. */
export const COMMENDATION_CATEGORIES = ['customer_service', 'vigilance', 'emergency', 'professionalism', 'teamwork', 'above_and_beyond'];
export const COMMENDATION_LABEL = {
  customer_service: 'Customer service',
  vigilance: 'Vigilance',
  emergency: 'Handled an emergency',
  professionalism: 'Professionalism',
  teamwork: 'Teamwork',
  above_and_beyond: 'Above and beyond',
};
/** A client can commend officers who worked their property in this many days. */
export const COMMEND_WINDOW_DAYS = 60;

/* ---------------------------------------------------- paid time off -- */

/**
 * Paid time off (PTO). W-2 employees paid by the hour earn it as they work:
 * an hour for every 30 worked, credited when the week's payroll closes, up to
 * a balance of 80 hours. They spend it on time-off requests; an approved
 * request takes the hours off the balance, and the next payroll close pays
 * them at the officer's rate on the day. Salaried staff and 1099 contractors
 * do not accrue it.
 */
export const PTO_ACCRUAL_WORKED_HOURS = 30;
export const PTO_CAP_HOURS = 80;
/** The most hours one day off can use. */
export const PTO_DAY_MAX_HOURS = 12;
export const PTO_KIND_LABEL = {
  accrual: 'Earned',
  used: 'Used',
  adjustment: 'Adjusted by the office',
};

/** Whether someone earns paid time off. */
export const ptoEligible = (u) => Boolean(u) && (u.employment_type || 'w2') === 'w2' && (u.pay_type || 'hourly') === 'hourly';

/** Hours earned for minutes worked, to the hundredth. */
export const ptoAccrued = (minutesWorked) =>
  Math.round(((Number(minutesWorked) || 0) / 60 / PTO_ACCRUAL_WORKED_HOURS) * 100) / 100;

/* --------------------------------------------------- patrol vehicles -- */

/**
 * The walk-round check before and after a stretch with a patrol vehicle. A
 * critical item failing takes the vehicle off the road until it is fixed; the
 * rest are noted for the next service.
 */
export const VEHICLE_CHECKS = [
  { key: 'lights', label: 'Headlights, brake lights and indicators', critical: true },
  { key: 'brakes', label: 'Brakes and parking brake', critical: true },
  { key: 'tyres', label: 'Tyres: tread, pressure, no damage', critical: true },
  { key: 'dash', label: 'No warning lights on the dash, no leaks', critical: true },
  { key: 'glass', label: 'Windscreen, wipers and mirrors', critical: true },
  { key: 'lightbar', label: 'Light bar, spotlight and PA', critical: false },
  { key: 'kit', label: 'First aid kit, fire extinguisher, flares', critical: false },
  { key: 'body', label: 'No new body damage', critical: false },
  { key: 'interior', label: 'Interior clean, nothing left behind', critical: false },
];

export const VEHICLE_CHECK_LABEL = Object.fromEntries(VEHICLE_CHECKS.map((c) => [c.key, c.label]));

/** Fuel in quarters of a tank, the way people read a gauge. */
export const FUEL_LEVELS = ['Empty', '1/4', '1/2', '3/4', 'Full'];

/** Miles between routine services, and how close counts as "due soon". */
export const VEHICLE_SERVICE_MILES = 5000;
export const VEHICLE_SERVICE_WARN_MILES = 300;
/** A reading this far past the last one is almost certainly a typo. */
export const VEHICLE_MAX_TRIP_MILES = 800;
/** How long a vehicle can be signed out before its start inspection is missing. */
export const VEHICLE_INSPECT_GRACE_MINUTES = 30;

/** Where a vehicle stands against its next service, from the odometer. */
export function serviceState(odometer, dueMiles) {
  if (odometer == null || dueMiles == null) return { state: 'unknown', milesLeft: null };
  const left = dueMiles - odometer;
  if (left <= 0) return { state: 'overdue', milesLeft: left };
  if (left <= VEHICLE_SERVICE_WARN_MILES) return { state: 'due', milesLeft: left };
  return { state: 'ok', milesLeft: left };
}

/**
 * Whether this officer may sign this item out.
 *
 * Returns a reason rather than a boolean, because every refusal here has to be
 * explainable to the person standing at the counter.
 */
export function equipmentEligibility({ item, officer, certifications = [] }) {
  if (!item.active) return { ok: false, reason: 'That item has been retired.' };
  if (item.status === 'maintenance') return { ok: false, reason: 'That item is in maintenance.' };
  if (item.status === 'lost') return { ok: false, reason: 'That item is recorded as missing.' };
  if (item.status === 'issued') return { ok: false, reason: 'Somebody already has that item.' };

  if (item.armed_only) {
    const armed = certifications.some(
      (c) => /class g/i.test(c.type || c.name || '') && (!c.expires_on || String(c.expires_on) >= new Date().toISOString().slice(0, 10))
    );
    if (!armed) {
      return { ok: false, reason: 'A current Class G licence is required to sign this out.' };
    }
  }

  if (officer.status !== 'active') {
    return { ok: false, reason: 'That officer is not active.' };
  }

  return { ok: true };
}

/* ================================================================ holidays === */

/** Holiday pay and the holiday bill rate both default to time and a half. */
export const HOLIDAY_DEFAULT_MULTIPLIER = 1.5;
export const HOLIDAY_MULTIPLIER_MIN = 1;
export const HOLIDAY_MULTIPLIER_MAX = 3;

const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** The nth weekday (0 Sunday .. 6 Saturday) of a month; n = -1 for the last one. */
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(year, month - 1, 1).getDay();
    return ymd(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(year, month, 0).getDate();
  const last = new Date(year, month - 1, lastDay).getDay();
  return ymd(year, month, lastDay - ((last - weekday + 7) % 7));
}

/**
 * The US federal holidays in a year, on the day itself rather than the
 * weekday a bank observes it on: a guard post is open on the Saturday the
 * Fourth falls on, and that is the day worked. `core` marks the six that
 * almost every security contract treats as a holiday.
 */
export function usHolidays(year) {
  return [
    { day: ymd(year, 1, 1), name: "New Year's Day", core: true },
    { day: nthWeekday(year, 1, 1, 3), name: 'Martin Luther King Jr. Day', core: false },
    { day: nthWeekday(year, 2, 1, 3), name: "Presidents' Day", core: false },
    { day: nthWeekday(year, 5, 1, -1), name: 'Memorial Day', core: true },
    { day: ymd(year, 6, 19), name: 'Juneteenth', core: false },
    { day: ymd(year, 7, 4), name: 'Independence Day', core: true },
    { day: nthWeekday(year, 9, 1, 1), name: 'Labor Day', core: true },
    { day: nthWeekday(year, 10, 1, 2), name: 'Columbus Day', core: false },
    { day: ymd(year, 11, 11), name: 'Veterans Day', core: false },
    { day: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day', core: true },
    { day: ymd(year, 12, 25), name: 'Christmas Day', core: true },
  ];
}

/**
 * The holiday premium on top of straight time for one person's payroll week.
 *
 * `entries` are the week's finished shifts in clock-in order, each with its
 * paid minutes, its pay rate and the holiday it started on, if any. Holiday
 * hours are paid at the holiday multiplier. Hours that are also overtime are
 * not paid both premiums on top of each other: they get the larger of the
 * two, so the holiday adds only what it pays beyond overtime, which is
 * usually nothing at time and a half each.
 */
export function holidayPremiumCents(entries, { thresholdMinutes, overtimeMultiplier = 1.5, earnsOvertime = true }) {
  let before = 0;
  let minutes = 0;
  let cents = 0;
  for (const e of entries) {
    const m = e.paid_minutes || 0;
    const otPart = earnsOvertime ? Math.max(0, before + m - Math.max(thresholdMinutes, before)) : 0;
    before += m;
    if (!e.holiday || !m || e.pay_rate_cents == null) continue;
    const mult = Number(e.holiday.pay_multiplier) || HOLIDAY_DEFAULT_MULTIPLIER;
    const straightPart = m - otPart;
    minutes += m;
    cents += (straightPart / 60) * e.pay_rate_cents * (mult - 1) + (otPart / 60) * e.pay_rate_cents * Math.max(0, mult - overtimeMultiplier);
  }
  return { minutes, cents: Math.round(cents) };
}
