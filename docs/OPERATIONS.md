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
| `autoClockOutAfterMinutes` | 120 | Shift left open this long past its end is auto-closed and flagged. An officer whose relief has not clocked in is held over instead, for up to 8 hours; once the relief clocks in, a forgotten clock-out closes at the handover, so the held-over time is paid. |
| `defaultGeofenceRadiusM` | 150 | Accepted distance from the post (overridable per post). |
| `maxTrustedAccuracyM` | 100 | Worse GPS accuracy than this is reported as *unverified*, not a violation. |
| `maxPinAttempts` / `lockoutMinutes` | 5 / 15 | Failed PIN attempts before lockout, and for how long. |
| `overtimeWeeklyHours` | 40 | Federal FLSA weekly line used for the overtime split. |
| `locationPingSeconds` | 60 | How often an on-duty device reports its position. |
| `minPingGapSeconds` | 20 | Reports closer together than this are acknowledged but not stored. Clock events are always kept. |
| `gpsStaleMinutes` | 15 | An officer on the clock with no position for this long shows as *GPS gone quiet*. |
| `locationRetentionDays` | 90 | Location history older than this is deleted by the sweep. |
| `minRestHours` | 8 | Fewest hours off between one shift ending (as worked) and the next starting. |
| `maxHoursPer24` | 16 | Most hours of work in any 24 hours. |
| `maxConsecutiveDays` | 6 | Most days in a row with a shift. |

## Flags

Raised automatically by the compliance sweep, which runs every minute and again
whenever an admin loads the dashboard. Closing one requires a written outcome,
which is kept on the officer's record.

| Flag | Severity | Raised when |
|------|----------|-------------|
| `late_clock_in` | warning | Clock-in past the grace period on a scheduled shift. |
| `missed_check_in` | critical | A status check-in window elapsed unanswered. Answering late raises it as a warning instead. |
| `geofence_violation` | critical | Clock-in from outside the post's radius, or with no fix, using an override reason. |
| `missed_clock_out` | warning | Shift auto-closed because nobody clocked out: at its scheduled end, or at the handover when the officer was held over for a late relief. |
| `early_departure` | warning | Clocked out more than 10 minutes early. |
| `no_show` | critical | Scheduled shift with no clock-in 30 minutes after start. |
| `unscheduled_shift` | info | Clocked in at a post with no matching shift. Not a fault — it tells dispatch coverage happened off-roster. |
| `off_post` | warning | A position reported mid-shift is outside the post's geofence. Raised once, on the way out — staying out does not raise another, walking back in and out again does. |

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

## Live tracking

While an officer is clocked in, the app reports the device's position about once a
minute. Each report is stored with the verdict against the post being worked -
inside, outside or unverified, and the distance - so a shift's trail reads the same
even if the post's geofence is moved later.

The live board gives every officer one status, in this order of priority:

| Status | Meaning |
|--------|---------|
| Duress alert | An open duress alert, whatever else is true. |
| Off post | On the clock, latest position outside the geofence. |
| No show | A shift started more than `noShowMinutes` ago and nobody clocked in. |
| Late - not clocked in | A shift started more than `lateGraceMinutes` ago, not yet a no-show. |
| On break | On the clock with a break open. |
| On post | On the clock, inside the fence (or no worse than unverified). |
| Starting soon | A shift starts within the next 12 hours. |
| Off duty | None of the above. |

*GPS gone quiet* is shown alongside, not instead: an officer can be on post with a
phone that has stopped reporting, and a supervisor needs to see both.

**Off the clock, nothing is sent.** The officer app still shows how far they are from
their next post, but it works that out on the device. What an employer may record
about where an off-duty worker is, is not a question this app should answer for you.

The mobile app tracks in the foreground only - while the app is open. Tracking with
the phone in a pocket needs background location permission, which both app stores
review closely and which is a policy decision to take deliberately.

## Handovers

The handover board looks at every officer on the clock whose shift ends within
`HANDOVER_WINDOW_MINUTES` (120; a supervisor can widen it to eight hours), and at the
shift that starts at the same post within an hour either side of that end. Each
handover is one of these, worst first:

| State | Meaning | Severity |
|-------|---------|----------|
| Relief late | The relief's shift started more than `lateGraceMinutes` ago and they have not clocked in at the post. | Critical |
| No relief assigned | The following shift has nobody on it. | Critical inside the hour, a warning before |
| Relief not confirmed | The relief has not confirmed this shift, at these times. | A warning inside the hour |
| Relief confirmed | Confirmed, and not due yet. | - |
| Relief on post | Clocked in: the officer can hand over and go. | - |
| Post closes | No shift follows at the post. | - |

A shift the same officer works straight after is not a handover. Late reliefs and
uncovered posts are critical alerts; the sidebar count includes every critical and
warning handover. Chasing a relief is refused for 10 minutes after the last chase.

## Rest and fatigue

A shift is judged against the officer's other shifts as worked: a shift they were
held over on ends when they clocked out, or now if they are still on post; cancelled
and missed shifts are left out. Breaking a rule is:

| Rule | Supervisor rostering the shift | Officer claiming or swapping into it |
|------|-------------------------------|--------------------------------------|
| Under `minRestHours` off before or after it | Warned | Refused |
| Over `maxHoursPer24` of work in any 24 hours | Warned | Refused |
| Over `maxConsecutiveDays` days in a row | Warned | Refused |

Working straight on into another shift is not short rest; it counts towards the
hours in a day. The board lists each problem once, on the shift that tips it, and
the alerts inbox raises those starting in the next 24 hours.

## Pay rates

Rates live on the employee record, where timesheets, invoices and reports read them.
The pay rates screen is the fast way to set them, and **every change is recorded in
the rate history** with who made it, why, and the date it takes effect - whether it
came from that screen, a bulk adjustment, or the employee record. Saving without
changing anything does not add a line.

- A change needs a reason and an effective date. **Every screen prices each hour at
  the rate in effect on the day it was worked** - reports, Timesheets and invoice
  cost alike - so a raise dated tomorrow leaves last month's figures alone and a
  back-dated correction reprices only the hours after its date.
- Moving somebody to 1099 on this screen clears *exempt* and is still refused without
  a W-9 on file.
- A bulk adjustment targets W-2, 1099 or both, armed, unarmed or both, by percent or
  by dollars, and always previews who it will touch before it is applied.
- Supervisors can read rates, because they staff shifts against margin. Only an
  administrator can change them.

### What a post pays

Some posts pay more than the officer standing them earns anywhere else - an armed
yard, an overnight desk. That is a property of the **post**, not the person: it is
paid to whoever is rostered on it, and keeps being paid after that officer moves on.
Raising the officer instead would pay them the armed rate for unarmed hours at
another site.

The list at the foot of the pay rates screen is every differential on file.

- A differential **replaces** the officer's own rate for the hours they work at that
  post, and changes nothing else.
- Leave the officer blank for the usual case: the post pays this to anybody. Naming
  one narrows it to them, for a rate somebody has negotiated that the post does not
  pay everyone.
- **Most specific wins**: this officer at this post, then whatever the post pays
  anybody, then the officer's own rate history, then their employee record.
- Each one is effective-dated like every other rate, so one agreed for next month
  prices next month and not last. One dated ahead is listed as *not yet*.
- Withdrawing one stops it applying from that moment. Hours already reported keep
  the cost they were reported at, because every screen prices an hour from the rates
  in force on its own day.

## Payroll

**Workforce -> Payroll** is where a pay period is reviewed, approved and closed.

- A pay period is **whole payroll weeks, Monday to Sunday**, one to four of them, so
  overtime is never split between two periods. *Open pay period* suggests the next one
  after the last, the same length. The current week can be opened early to watch hours
  come in; it can only be closed the day after it ends.
- Each officer with hours in the period gets a line: hours, regular and overtime pay,
  gross, the sites they worked, and anything worth a second look - a shift still
  clocked in, no pay rate, a shift the system closed, a punch an admin corrected, a
  clock-in outside the geofence, unresolved flags, overtime, a contractor with no W-9.
  A shift still clocked in or a missing rate **blocks** approval; the rest are for you
  to judge.
- **Approve** officers one at a time, by selection, or with *Approve all ready*. An
  approval is tied to the exact hours and rates it was given against. If a punch is
  corrected or a rate back-dated afterwards, that officer shows **Changed since
  approval**, with what was approved beside what is owed now, and must be approved
  again.
- **Close period** is available once the period has ended and every officer is
  approved at their current figures. Closing freezes the figures and **locks the
  period**: punches in it cannot be corrected, no entry can be moved into it, and no
  pay rate can take effect on or before its last day. Bill-rate changes are not
  affected.
- **Reopen** needs a reason, which is kept on the period and the audit log. Approvals
  stay in place; anyone whose hours or rate change while it is open must be approved
  again before it closes.
- **Payroll register** downloads the period as CSV: W-2 employees then 1099
  contractors, with hours, regular, overtime and gross pay, and totals by
  classification. It is the file to hand to a bookkeeper or payroll provider; taxes,
  deductions and net pay are theirs.
- The dashboard and the *Payroll* menu item show how many ended periods are still
  open. Supervisors can read payroll; only administrators can approve, close, reopen
  or export.

## Client coverage requests

A client can ask for officers beyond their standing roster from the portal's
**Requests** tab: a date, a start and finish (a finish earlier than the start runs past
midnight), how many officers (1-10), whether they must be armed, and what it is for.
It has to start at least an hour ahead and no more than 120 days out, and one request
covers up to 16 hours. Anything sooner is a phone call.

Requests land in **Workforce -> Client requests**, counted on the menu and the
dashboard. A supervisor or administrator answers each one once:

- **Schedule** puts that many *unassigned* open shifts on the post you choose - one of
  that site's posts, and an armed post if the client asked for armed officers. Staff
  them from the schedule as usual; the shifts carry a note saying which request they
  came from. An optional note goes to the client with the confirmation.
- **Decline** needs a reason, which the client reads in the portal and in the email.

The client is emailed either way. They can withdraw a request until it is answered;
after that, changes go through the office.

## Reports

Every report is built from the same rows as the timesheet and invoice, so the numbers
agree. Things worth knowing when reading them:

- **Overtime is decided per payroll week (Monday to Sunday)**, never across a range.
  Forty hours in each of two weeks is eighty hours of straight time. A range that
  starts or ends mid-week counts only the hours inside it.
- **Labor cost by site is base pay.** The overtime premium belongs to the officer's
  week, not to any one site, so it appears in the payroll and overtime reports.
- **Billing** uses the shift's own rate if one was agreed, then the post's standing
  rate, then the officer's.
- **Each hour is paid at the rate in effect that day.** When a rate changes mid-week,
  the overtime premium is worked out on the week's weighted-average rate - the FLSA
  "regular rate" - which is how a payroll provider prices it.
- Unpaid meal breaks come off both pay and billing. Shifts still in progress are not
  counted until the officer clocks out.

## Employment classification and pay

Classification is a field on the employee record, not a note, because it changes the
arithmetic. The rules live in `packages/shared/src/domain.js`, and pricing a set of
worked hours happens in one place, `apps/server/src/services/payroll.js`, which the
reports, the Timesheets screen and invoice cost all call - so they cannot disagree.

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
they are the evidence trail for payroll disputes and client billing.

Continuous location history is different, and it has a retention window: the sweep
deletes location reports older than `locationRetentionDays` (90). Hours, punches and
flags are unaffected - the clock-in and clock-out positions live on the time entry
itself. Ninety days is a starting point, not advice; confirm the right period with
counsel before relying on it.
