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

export const EMPLOYEE_STATUS = ['active', 'suspended', 'terminated'];

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
