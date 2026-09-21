# Operations reference

How USA Security Connect decides what counts as a problem, and who sees it.
Every threshold below lives in `packages/shared/src/domain.js` — change it there
and the API, web app and mobile app all follow.

## Thresholds

| Rule | Default | What it controls |
|------|---------|------------------|
| `lateGraceMinutes` | 7 | Minutes past shift start before a clock-in is *late*. |
| `earlyClockInMinutes` | 30 | How early an officer may start the clock. Earlier is refused. |
| `earlyDepartureMinutes` | 10 | Leaving more than this before shift end is flagged. |
| `noShowMinutes` | 30 | No clock-in this long after start ⇒ the shift is a no-show. |
| `defaultCheckInIntervalMinutes` | 60 | Status check-in cadence (overridable per post). |
| `checkInWindowMinutes` | 10 | How long the officer has to answer before it is missed. |
| `autoClockOutAfterMinutes` | 120 | Shift left open this long past its end is auto-closed and flagged. |
| `defaultGeofenceRadiusM` | 150 | Accepted distance from the post (overridable per post). |
| `maxTrustedAccuracyM` | 100 | Worse GPS accuracy than this is reported as *unverified*, not a violation. |
| `maxPinAttempts` / `lockoutMinutes` | 5 / 15 | Failed PIN attempts before lockout, and for how long. |
| `overtimeWeeklyHours` | 40 | Federal FLSA weekly line used for the overtime split. |

## Flags

Raised automatically by the compliance sweep, which runs every minute and again
whenever an admin loads the dashboard. Closing one requires a written outcome,
which is kept on the officer's record.

| Flag | Severity | Raised when |
|------|----------|-------------|
| `late_clock_in` | warning | Clock-in past the grace period on a scheduled shift. |
| `missed_check_in` | critical | A status check-in window elapsed unanswered. Answering late raises it as a warning instead. |
| `geofence_violation` | critical | Clock-in from outside the post's radius, or with no fix, using an override reason. |
| `missed_clock_out` | warning | Shift auto-closed at its scheduled end because nobody clocked out. |
| `early_departure` | warning | Clocked out more than 10 minutes early. |
| `no_show` | critical | Scheduled shift with no clock-in 30 minutes after start. |
| `unscheduled_shift` | info | Clocked in at a post with no matching shift. Not a fault — it tells dispatch coverage happened off-roster. |

### Deliberate design choices

- **Bad GPS is not treated as misconduct.** A fix worse than 100 m accuracy is
  recorded as `unverified` so a supervisor can see it, but the officer is not
  flagged for standing in a stairwell.
- **An officer is never blocked from working.** Outside the geofence, they can
  still clock in by giving a reason; the reason and distance go to the supervisor.
  Refusing to start the shift would leave a post unmanned, which is worse.
- **Missing a check-in does not stop the cadence.** The next check-in is queued
  immediately, so one missed prompt does not silence the rest of the shift.
- **Worked shifts are cancelled, never deleted.** Deleting a shift someone already
  clocked into would destroy payroll evidence.
- **Corrections are additive.** Editing a punch preserves the original clock-in and
  clock-out alongside the reason and who made the change.

## Roles

| Role | Can |
|------|-----|
| `officer` | Own clock, check-ins, tours, incidents, schedule, messages, training. |
| `supervisor` | Everything an officer can, plus the admin console read/review: dashboard, flags, incident review, scheduling, broadcasts, and logging post visits. |
| `admin` | Everything, plus employee records, PIN generation and reset, time-entry corrections, sites and posts, tours, training, and the audit log. |

Roles are ranked, so a check for "supervisor" also passes for an admin. The system
refuses to demote or deactivate the last active administrator.

## PIN lifecycle

1. An admin creates the employee. The server generates a random 4-digit PIN,
   rejecting trivial ones (`1111`, `1234`, `4321`).
2. The PIN is shown **once**, in a dialog the admin dismisses after handing it over.
   Only a scrypt hash is stored, so it cannot be shown again.
3. The officer signs in with employee code + PIN and is forced to choose their own
   before the app opens.
4. If they forget it, an admin issues a new one, which resets the same flow and
   clears any lockout.

## Incident references

`USC-<year>-<sequence>` — for example `USC-2026-0041`, numbered per calendar year.
Reports cannot be edited after submission; a supervisor adds review notes instead,
and those notes are visible to the reporting officer.

## Data retention

The audit log, time entries and incidents are designed to be kept indefinitely —
they are the evidence trail for payroll disputes and client billing. GPS traces on
individual check-ins are a different matter and worth a deliberate retention policy;
they are stored per check-in and per clock event and can be pruned without affecting
hours or compliance history.
