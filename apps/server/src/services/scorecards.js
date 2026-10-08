/**
 * The officer score on the scorecards (0-100), from what the records show.
 * It weighs what a client notices first:
 *
 *   35  punctuality   clocked in within the grace period of the shift start
 *   25  attendance    shifts worked out of shifts that should have been; a
 *                     call-off counts as half a missed shift - they gave
 *                     warning, but the shift still had to be covered
 *   25  check-ins     answered in their window (a late answer counts half)
 *   15  clean record  fewer compliance flags per shift worked
 *
 * A part with nothing to judge (no check-ins due, say) is left out and the
 * rest scaled up, so an officer is not marked down for what never came up.
 */

export const SCORE_WEIGHTS = { punctuality: 35, attendance: 25, checkIns: 25, record: 15 };
/** How much of a missed shift one call-off counts as. */
export const CALL_OFF_WEIGHT = 0.5;

export function officerScore({
  worked = 0, onTime = 0, missed = 0, calledOff = 0, checksOk = 0, checksLate = 0, checksMissed = 0, flags = 0,
} = {}) {
  const due = worked + missed + calledOff * CALL_OFF_WEIGHT;
  const checksDue = checksOk + checksLate + checksMissed;
  const parts = [
    [SCORE_WEIGHTS.punctuality, worked ? onTime / worked : null],
    [SCORE_WEIGHTS.attendance, due ? worked / due : null],
    [SCORE_WEIGHTS.checkIns, checksDue ? (checksOk + checksLate * 0.5) / checksDue : null],
    [SCORE_WEIGHTS.record, worked ? Math.max(0, 1 - flags / worked / 2) : null],
  ].filter(([, v]) => v !== null);
  const weight = parts.reduce((a, [w]) => a + w, 0);
  return weight ? Math.round((parts.reduce((a, [w, v]) => a + w * v, 0) / weight) * 100) : null;
}
