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

## Employment classification and pay

Classification is a field on the employee record, not a note, because it changes the
arithmetic. `computePay()` in `packages/shared/src/domain.js` is the single place it
happens, and the API, admin console and timesheet export all call it.

| | W-2 employee | 1099 contractor |
|---|---|---|
| Overtime past 40h/week | Yes, at their multiplier (1.5 default) | **No** — contractors are not owed FLSA overtime |
| Exempt status | Available for salaried managers | Refused by the API |
| Required paperwork | — | W-9 on file before the record can be made active |
| Also tracked | — | Business name, tax ID last four, signed agreement, insurance expiry |
| Pay basis | Hourly, salary or per shift | Hourly, salary or per shift |

Two deliberate guardrails:

- **A 1099 cannot be set active without a W-9.** Missing contractor paperwork is the
  classic audit finding, so the API refuses rather than warns.
- **Overtime is never paid to a contractor**, even if a rate is set. Paying FLSA
  overtime is one of the behaviours that blurs the contractor line, so the calculation
  will not do it silently.

Classification is a legal determination about how the work is actually controlled, not
a preference. The app records and enforces the decision; it does not make it. Check
with counsel or a payroll provider before reclassifying anybody.

### Money

Every amount is stored in whole cents to avoid float drift. Only the **last four
digits** of a tax ID are kept — the full EIN or SSN belongs in the payroll system.

- **Pay rate** is what the worker earns.
- **Bill rate** is what the client is charged, with no overtime uplift unless the
  contract says so.
- **Margin** is the difference, shown per person and in the timesheet totals.
- **Unpaid meal breaks** are deducted before anybody is paid for the time.

These are planning figures. The payroll provider remains the source of truth.

## Credential expiry

Certifications, state licences and contractor certificates of insurance all feed one
board. Anything inside 60 days is *expiring*; anything past its date is *expired*, and
an officer on that list should be pulled from post until it is renewed — particularly a
Class G on an armed post.

## Duress alerts

The button fires on confirmation without waiting for a GPS fix, because a fix can take
ten seconds the officer may not have; the position is attached if it arrives and sent as
an update if it arrives late. Repeat presses update the open alert rather than creating
new ones, so responders see a single incident. Acknowledging notifies the officer that
help is coming, and closing one requires a written account of what happened.

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
