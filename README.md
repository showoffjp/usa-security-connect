# USA Security Connect

Workforce operations platform for **USA Security & Protection Group** — guard tour, time
and attendance, incident reporting, supervision and billing, in one system:

- a **web app** for officers *and* the admin console,
- a **mobile app** built from one codebase for **Android and iPhone**, and
- a **client portal** where a site contact sees the service they are paying for.

All three talk to the same API, and the rules that decide "late", "missed check-in" or
"outside the geofence" live in one shared module so no surface can disagree with
another. One thing gets captured once: an officer's clock-in is the same record that
produces their timesheet, the client's coverage report and the invoice line.

---

## Quick start

```bash
npm install
npm run seed      # demo sites, posts, officers, shifts, incidents, tours
npm run dev       # API on :4000, web app on :5173
```

Open <http://localhost:5173> and sign in with a demo code + PIN:

| Code | PIN | Who | Notes |
|------|-----|-----|-------|
| `1001` | `2468` | Vince Ortega | Administrator — W-2 salaried, exempt |
| `1002` | `3571` | Renata Diaz | Field supervisor — W-2 hourly |
| `1003` | `4812` | Marcus Bell | Officer, **currently on post** |
| `1004` | `5930` | Janelle Carter | Officer — licence expiring soon |
| `1005` | `6174` | Dwayne Foster | **1099 contractor**, armed post |
| `1006` | `7285` | Alicia Nunez | Officer — W-2 hourly |
| `1007` | `8140` | Kevin Osei | New hire — forced to change PIN at first sign-in |
| `1008` | `9351` | Renee Okafor | **1099 contractor**, paid per shift |

Around those eight, the seed builds a regional operation: **ten client sites** from
Pensacola to Miami, **43 staff** (27 W-2, 8 1099 contractors, 4 armed), a month of
rosters, 6,000+ GPS points, and a live "right now" whatever hour you seed it - officers
on post, one who has walked off it, one on a meal break, one whose phone has gone
quiet, one running late and one who never turned up. Every one of them can sign in:

<details>
<summary>All 35 regional accounts, 1009-1043</summary>

| Code | PIN | Who | Notes |
|------|-----|-----|-------|
| `1009` | `8271` | Terrence Boyd | Supervisor, W-2, Miami |
| `1010` | `7190` | Megan Hollis | Supervisor, W-2, armed, Tallahassee |
| `1011` | `6109` | Andre Mitchell | Officer, W-2, Miami |
| `1012` | `5028` | Sofia Ramirez | Officer, W-2, Miami |
| `1013` | `3947` | Jamal Whitaker | Officer, W-2, Hialeah |
| `1014` | `2866` | Keisha Turner | Officer, W-2, Miami |
| `1015` | `1785` | Daniel Cho | Officer, W-2, Miami |
| `1016` | `9704` | Tyler Brooks | Officer, W-2, St. Petersburg |
| `1017` | `8623` | Hector Alvarado | Officer, **1099**, St. Petersburg |
| `1018` | `7542` | Brianna Scott | Officer, W-2, Tallahassee |
| `1019` | `6461` | Owen Gallagher | Officer, W-2, Tallahassee |
| `1020` | `5380` | Raymond Hayes | Officer, **1099**, armed, Tallahassee |
| `1021` | `4299` | Emily Novak | Officer, W-2, Gainesville |
| `1022` | `3218` | Christopher Lane | Officer, W-2, Gainesville |
| `1023` | `2137` | Isaiah Coleman | Officer, W-2, Gainesville |
| `1024` | `1056` | Natalie Price | Officer, W-2, Daytona Beach |
| `1025` | `8975` | Luis Castillo | Officer, **1099**, Daytona Beach |
| `1026` | `7894` | Wesley Tate | Officer, W-2, Pensacola |
| `1027` | `6813` | Denise Holloway | Officer, W-2, Pensacola |
| `1028` | `5732` | Victor Morales | Officer, **1099**, armed, Pensacola |
| `1029` | `4651` | Tanisha Greene | Officer, W-2, Miami |
| `1030` | `3570` | Cody Fletcher | Officer, W-2, Pensacola |
| `1031` | `2489` | Jasmine Reed | Officer, W-2, Pensacola |
| `1032` | `1408` | Gabriel Santos | Officer, W-2, Miami |
| `1033` | `9327` | Priya Nair | Officer, W-2, Coral Gables |
| `1034` | `8246` | Ethan Walsh | Officer, W-2, St. Petersburg |
| `1035` | `7165` | Olivia Bennett | Officer, W-2, Tallahassee |
| `1036` | `6084` | Darnell Hughes | Officer, **1099**, armed, Tallahassee |
| `1037` | `5003` | Chloe Martin | Officer, W-2, Gainesville |
| `1038` | `3922` | Mason Clark | Officer, W-2, Gainesville |
| `1039` | `2841` | Grace Kim | Officer, W-2, Ormond Beach |
| `1040` | `1760` | Jordan Ellis | Officer, W-2, Gainesville |
| `1041` | `9679` | Brandon Moss | Officer, **1099**, Daytona Beach |
| `1042` | `8598` | Alexis Rivera | Officer, W-2, Tallahassee |
| `1043` | `7517` | Samuel Ortiz | Officer, W-2, Pensacola — **on leave, cannot sign in (by design)** |

</details>

Samuel Ortiz (`1043`) is deliberately on leave, to show what an inactive account
looks like: he is refused at sign-in with a message saying so, until a supervisor
sets him back to active under Employees. Every other code above signs in.

`npm run seed` prints every code and PIN, and who is on duty at that moment.

> These fixed PINs exist only in the demo seed. Real accounts get a random PIN
> generated in the admin console and shown exactly once.

### The three staff tiers

The three accounts at the top of that table are one of each kind. They do not
merely see more or less of the same screen — they get different applications.

| | Officer `1003` | Supervisor `1002` | Administrator `1001` |
|---|---|---|---|
| **Lands on** | Their own shift | The live operations dashboard | The live operations dashboard |
| **Navigation** | 5 tabs | 26 destinations | 27 destinations |
| **Can do** | Clock in/out, check in, walk tours, file incidents, claim shifts, request time off | All of that, plus run the shift: live GPS tracking, the punch log, review flags and incidents, approve time off and swaps, build and copy rosters, read timesheets, pay rates and every report | All of that, plus change the record: create staff, reset PINs, adjust time entries, set up sites and posts |
| **Money** | — | Reads invoices, pay rates and margin | Sets pay rates (single or bulk, effective-dated); approves and closes payroll periods; raises, issues and voids invoices; manages client portal logins |
| **Audit log** | — | — | Yes |

A supervisor is a working officer too — they still have their own time clock.

The boundaries are enforced in the API, not just hidden in the UI:
`apps/server/test/roles.mjs` checks each one from both sides, so a control that
gets hidden but not gated will fail the suite.

A **client contact** is not a staff account at all. Separate sign-in, separate
token, 6 destinations, and no path to any of the above.

The client portal is at <http://localhost:5173/portal>, with its own sign-in:

| Email | Password | Property |
|-------|----------|----------|
| `dana.whitfield@riverfrontholdings.com` | `riverfront-portal-01` | Riverfront Commerce Center |
| `marcus.reyes@palmettoridgehoa.org` | `palmetto-portal-02` | Palmetto Ridge Residences |
| `alicia.grant@gulfportfreight.com` | `gulfport-portal-03` | Gulfport Logistics Yard |
| `carla.mendez@harborviewhealth.org` | `harborview-portal-04` | Harborview Medical Center |
| `rpike@emeraldcoastlogistics.com` | `pensacola-portal-05` | Pensacola Distribution Center |
| `dfaulkner@capitalplazart.com` | `capital-portal-06` | Capital Plaza Office Tower |

Sign in as two different contacts to see the scoping: neither can reach the other's
property, and neither sees a pay rate.

### Mobile

```bash
npm run mobile            # Expo dev server; press a for Android, i for iOS
npm run mobile:check      # bundles the app without a device, to catch errors
```

The Android emulator reaches your machine on `10.0.2.2`, which is the default in
`apps/mobile/app.json`. On a physical phone, set your machine's LAN address:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.50:4000/api npm run mobile
```

---

## What it does

### Officer (web + mobile)

- **Clock in / out** behind a deliberate slide gesture, with GPS verification against
  the post's geofence. Too far away and the officer must give a reason, which is
  attached to the record and raised with a supervisor.
- **Where you are vs where you should be** — the home screen watches the device's
  position and compares it with the assigned post: "Inside the geofence, 12 m from the
  post", or "340 m from your post - head NE", with a map, the line back, and
  directions. While clocked in the position is shared with dispatch about once a
  minute; off the clock it is compared with the next post **on the device only** and
  nothing is sent. Walking out of the geofence mid-shift raises one flag on the way out.
- **Status check-ins** on a per-post cadence. Miss the window and it is flagged
  automatically; the next prompt is still queued so the cadence continues.
- **Incident reports** — category, severity, what happened, how it was resolved,
  people involved and notified, police report number, cost recovery, and photos
  (camera or library on mobile).
- **Tours and tasks** — walk a route, scan each checkpoint by NFC/QR tag or manually,
  tick off per-checkpoint tasks, or skip with a recorded reason. Required checkpoints
  block completion until they are dealt with. In the browser the camera reads the
  printed QR tag (Chrome and Edge; elsewhere, type the code printed under it). A
  checkpoint marked visited without a tag is recorded as manual, never as a scan.
- **Post orders** — when a supervisor changes the standing orders for the officer's
  post, the home screen leads with them: what changed, who changed it, and the full
  orders, until the officer confirms "I have read these orders". Only the version
  in force can be acknowledged. The mobile app's home screen shows the same card, the
  unread pass-down notes (each with **Got it**) and the site's contacts, tap to call.
- **Post log in the mobile app** — who is signed in on site (sign them out with a tap),
  sign someone in with the same watchlist check as the web (a match stops it; letting
  them in anyway needs a reason), and log patrols, alarms and observations, marked
  internal when the client should not see them.
- **Licence reminders** — the home screen (web and mobile) warns when the officer's
  licence or any certification lapses within 30 days, or already has, listing each
  with its date.
- **Before you go** — sliding to clock out (web and mobile) first shows what the shift
  did: time on post, check-ins answered and missed, patrols and checkpoints, visitors
  in and out, activity entries and incident reports. If the officer has not left a
  pass-down note, it offers a box for one (optionally marked important). Clocking out
  never depends on it; **Stay on post** closes it.
- **Install to the home screen** — the web app is installable (Android, iOS "Add to
  Home Screen", desktop), with the shield as its icon; the client portal installs as its
  own app that opens on the portal. If the signal drops, pages show a "No connection"
  screen with a 911 button instead of the browser's error. API responses are never
  cached: a clock-in or post order is always the live one.
- **Night mode** — the account menu has Auto, Light and Night. Auto follows the
  device, so a phone set to dark at night gets a dark screen without asking. The
  choice is kept per device and applied before the first paint, so there is no
  white flash. Street maps are dimmed to match. Printing is always on white.
- **Schedule** — upcoming and worked shifts, hours, overtime, and anything flagged. A
  shift on a company holiday is marked with the holiday's name, and the next holiday
  is named above the list, with the rate it pays if the officer earns the premium.
- **Signed out to you** — the home screen (web and mobile) lists the keys, radios,
  firearm or patrol vehicle the officer holds, with **Hand back** for the small items.
- **Patrol vehicle checks** — before driving a signed-out vehicle the officer does a
  walk-round check: odometer, fuel, and OK or Problem for each of nine items (lights,
  brakes, tyres, dash warnings, glass, light bar, safety kit, body, interior). Every item
  must be answered and a problem needs a note. A failed safety item says "Do not drive"
  and tells the supervisors. The vehicle goes back with an end check, which records the
  miles of the stretch. The odometer can never go backwards, and a jump of more than
  800 miles is refused as a typo.
- **Confirm a shift** — each upcoming shift in the next 7 days has **Confirm I'll be
  there** (web and mobile, on the schedule and the home screen's next-shift card). A
  day ahead, an officer who has not confirmed gets one push reminder that opens the
  schedule. A confirmation is for that officer, post and time: if the shift is moved or
  handed to someone else it needs confirming again.
- **Fix a time** — under Schedule → Worked (web and mobile), the officer's punches from
  the last 14 days, each marked if the system closed it, it was late or it has been
  corrected. A wrong one can be sent to the office: the clock-in or clock-out it should
  have been (a date-time on the web, a few minutes either way on the phone) and what
  happened. They see it waiting, can withdraw it, and see the answer, with the office's
  note if it was declined. A shift still running cannot have its clock-out changed, and
  hours in a closed pay period have been paid, so those go to the office instead.
- **My pay** (on the profile page) — the officer's own pay basis, an estimate for the
  week so far, and every closed pay period: hours, regular and overtime pay, gross and
  where they worked, exactly as payroll approved it, with any expenses paid back
  alongside and any holiday premium beside the overtime. A 1099 contractor sees *My
  payments*, with no overtime or holiday premium.
- **My expenses** (profile on the web, the **Worked** tab on the phone) — claim back
  parking, tolls, supplies, meals or miles driven in your own car on the job. Mileage
  is priced at the IRS rate (70¢ a mile) as it is typed; anything else over $25 needs
  a photo of the receipt, taken with the phone camera. Claims go back 60 days and up
  to $1,000 each. The list shows what is waiting, approved (paid with the next payroll),
  paid and in which pay period, or declined and why; a claim still waiting can be
  withdrawn.
- **Broadcasts and training** — priority notices with read/acknowledge receipts, and
  required videos that cannot be marked complete until they have actually been watched.
- **Post log** — the post's own two logs, opened from the home screen:
  - **Visitors and vehicles**: sign people in at the post (name, company, visitor,
    contractor, delivery or vendor, who they are seeing, plate, vehicle and badge) and
    out again when they leave. Anyone on duty at the same site can sign them out,
    because people leave by the other door. The client sees the log in their daily
    report.
  - **Pass-down notes**: what one shift tells the next, marked important when it is.
    The next officer on the post sees the notes on their home screen, can read them
    up to twelve hours before the shift starts, and acknowledges each one.
  - **Activity log**: short, time-stamped entries through the shift (patrol,
    observation, access, alarm, safety, customer service): the stuff of a daily
    activity report. Entries go into the client's report unless the officer marks
    them internal, and an officer can take back their own entry from the same shift.
  - **Building issues**: report a light out, a door that will not lock, a leak or a
    hazard, marked urgent when it is. The client sees it on their portal overview.
    When the client says "seen, it's in hand" or "fixed", with a note, the officer on
    post sees the reply.
  - **Lost and found**: log an item, where it was found and where it is kept. Hand
    it back by recording who collected it and the phone number or ID checked.
    Disposing of property is for supervisors only.
  - **Watchlist**: the people not to be let in at this site or any site, with a
    description, vehicle, the reason, and what to do: refuse entry, call the police,
    call the supervisor, or escort only. Every visitor sign-in is checked against
    it by name, alias and plate. A match stops the sign-in and shows the entry. The
    officer can let the person in anyway only by naming the entry and giving a
    reason, such as the ID they checked, and that stays on the record.
  - **Vehicles**: log a parking violation (fire lane, no permit, accessible bay,
    blocking, abandoned, reserved) and what was done (warning, tagged, booted,
    towed). Look up any plate first: its violations at every site, the visits it
    came in with, and whether it is on the watchlist. Two or more in six months
    marks it a repeat offender, and each row says which offence it is.
- **Site contacts** on the home screen: the property manager, maintenance, the alarm
  company and the police non-emergency line for the site they are on, each a tap
  to call, with who answers after hours.
- **Messaging** with supervisors and dispatch.
- **Supervisor visits** (supervisors only) — uniform, post orders, equipment and site
  checks, logged with GPS. Two notes: an internal one (what was seen, what the officer
  was coached on) and a separate note for the client. The client never reads the
  first.
- **Your last supervisor visit** — for a week after a visit, the officer's home screen
  shows who came, how it was rated, which checks passed and what the supervisor said.
- **Calls sent to you** — when the office sends the officer a call for service (an
  alarm, someone suspicious, a lockout, an escort), it goes to the top of the home
  screen (web and mobile, with a push) until it is cleared: **On my way**, **I'm on
  scene**, then **Clear call** with how it ended and what they found, which the client
  reads. **I can't take it** turns it back with a reason. Clocking out with a call open
  hands it back to the office, and "Before you go" warns first.
- **Duress button** — one tap plus a confirmation alerts every supervisor with the
  officer's name, post and position. It fires immediately rather than waiting on GPS,
  repeat presses update the same alert instead of flooding the board, and the officer
  is told the moment a supervisor acknowledges.
- **Meal and rest breaks** — meal time is unpaid and deducted from the shift; rest
  breaks stay paid.
- **Time-off requests** — pick dates and a reason; overlapping requests are refused,
  and the decision comes back as a notification. On the web too, on the profile page.
- **Commendations** — thanks from a client or a supervisor: on the home screen (web
  and phone) until read, with who it is from, the property and what it was for, and
  every one on the profile.
- **Paid time off** — W-2 employees paid by the hour earn an hour for every 30 worked,
  credited when the week's payroll closes, up to 80 hours. The balance, what is already
  asked for and what is free to use are on the profile (web) and the Updates tab (phone),
  with a statement of every hour earned, used or adjusted. A time-off request can be paid
  from it: eight hours a day is suggested, at most 12, never more than is free, and never
  for unpaid leave. The pay stubs show the time off paid and the hours earned.
- **Push notifications** for urgent broadcasts, check-ins that fall due, and messages.

### Admin console (web)

- **Keyboard shortcuts** — **?** lists them; **g** then a letter jumps to a screen
  (d dashboard, l live tracking, f flags, i incidents, p post logs, s schedule,
  e employees, t timesheets, r reports, h site health, v field visits, c client portal). Off while
  typing in a field.
- **Hiring** (Workforce → Hiring) — applications from the public form at **/apply** and
  the walk-ins and referrals the office adds, on a board by stage: applied, screening,
  interview, offer. Each applicant has their details, a pre-hire checklist (licence
  verified with FDACS, background check and I-9 right to work are required; drug test,
  references and orientation are tracked), notes, and a move to the next stage or a
  close with a reason. An administrator hires from the offer stage once the required
  checks are done: that makes the employee record, with the licence they applied with,
  and shows the employee code and a starting PIN once. New applications are in the
  alerts inbox and counted in the sidebar until someone picks them up. Applicants are
  not users: no code, no PIN and no access until they are hired.
- **Quick search** — press **Ctrl+K** (Cmd+K, or `/`) anywhere in the console, or use
  the search button in the header. Find an officer by name, code or phone, a site by
  name, city or client, an incident by its number, or any screen by name. Arrow keys
  and Enter open the result.
- **Post logs** — everyone signed in at a site right now, with a count per site and in
  the sidebar; any day's visitor log; and every pass-down note with who has read it.
  The daily activity report lists the day's visitors.
  The same screen has each day's **activity log** across sites (internal entries
  marked), every **building issue** with its status and the client's reply (reopen
  or close them), and **lost and found** with the items held over 30 days picked
  out. It also keeps the **watchlist** (add, edit, lapse or remove entries, and
  see every sign-in that overrode a match) and **vehicles** (repeat offenders by
  plate, and every violation by site and period).
- **Alerts inbox** — the bell in the header, with the unread count, lists everything
  waiting on a supervisor: open duress alerts, no-shows, missed check-ins and
  walk-offs from the last three days, watchlist overrides, urgent building issues,
  unanswered low client ratings, open coverage requests, client requests to change
  post orders, patrols finished with required checkpoints skipped or never finished,
  and licences lapsing within 14 days. Most serious first; opening one goes to the screen that deals with it and
  marks it read. Alerts are worked out from the records, so they clear themselves when
  the problem is resolved; only who has read what is stored, per person.
- **Post orders** (Post logs → Post orders) — each post's standing orders, versioned.
  Issuing new orders, or editing the instructions on the Sites screen, makes a new
  version; the old ones stay on record with who acknowledged each. Every post shows
  who has not yet read the version in force: anyone who worked it in the last 30 days
  or is scheduled on it in the next 14. A client's requested change shows on its post
  with **Apply as a new version** (the reply goes with it) or **Decline**.
- **Site contacts** (Post logs → Site contacts) — who officers call at each site,
  kept by supervisors and by the client; each entry says who added it.
- **Client notices** (Client portal → Notices) — post a notice to every property or to
  chosen ones, as information, important or urgent, from now or scheduled up to 60 days
  ahead, until a date or until withdrawn, and optionally email it to every contact who
  can see it. Each shows whether it is live, scheduled, ended or withdrawn, and how many
  of its contacts have read it.
- **Client feedback** — every client's monthly rating per property with their
  comment. Two stars or fewer without a reply is counted on the dashboard and in
  the sidebar. The reply goes back to the client's portal.
- **CSV downloads** from every post-log tab (visitors, vehicles, activity, building
  issues, lost and found), the scorecards and client feedback. Any cell starting
  with `=`, `+`, `-` or `@` is neutralised so a spreadsheet cannot run it.
- **Dispatch** (Operations → Dispatch, **g k**) — calls for service: raise one the office
  took by phone (site, post, type, emergency/urgent/routine, where, what, caller), or
  pick up one a client raised in the portal. Each call lists every officer on duty,
  whoever is already at the property first, then by distance from their last GPS
  position, marked if they are on a break or another call; send it with one click,
  re-send it, clear it from the desk or cancel it. Every step is timed (to send, to
  acknowledge, to on scene, against a 5/15/45-minute target by priority) and logged,
  including an officer turning it back. A call nobody has been sent to, or one not
  acknowledged within three minutes, is in the alerts inbox; the sidebar counts open
  calls. The **call response times** report breaks it down by site.
- **Field visits** (Operations → Field visits) — every active site with its last
  supervisor visit, longest first; a site with no visit in 14 days is **due** (a badge in
  the sidebar, an alert in the inbox, a line on site health) until someone goes. Every
  visit is listed with the checks that failed, the rating, the internal notes and what
  the client reads; filter to the ones that found a problem, or by site. A visit can be
  logged from the desk too, dated up to a week back. A visit that found a problem is
  raised in the alerts inbox.
- **Site health** (Reporting → Site health) — every active site's month side by side,
  worst first, scored out of 100 with the reasons listed: shifts not covered, checkpoints
  not scanned, serious incidents, building issues left open, a low client rating, a
  site overdue for a supervisor visit. The
  numbers are the ones each client reads in their monthly report (the two share one
  calculation), and any site's full month opens from the board, ready to print.
- **Officer scorecards** — every officer who worked in the last 7, 30 or 90 days,
  ranked out of 100: punctuality 35 (clocked in within the grace period), attendance
  25 (shifts worked out of shifts due), check-ins 25 (answered in time; late counts
  half), clean record 15 (compliance flags per shift). A part with nothing to judge
  is left out rather than scored as zero. Filter to those under 75. Commendations are
  counted beside the score (and how many came from clients), never part of it.
- **Overtime watch** (Workforce → Overtime watch) — W-2 officers paid by the hour
  heading past 40 hours this payroll week or next: hours worked, hours still on the
  roster, the projection, the overtime hours and the premium they cost, and the shift
  that first carries each one over the line. **Find cover** opens that shift on the
  schedule, where the suggested officers put those with hours to spare first.
  Overtime that a shift not yet started would cause is counted on the sidebar and
  raised in the alerts inbox. Contractors and salaried staff, who do not earn
  overtime, are left out.
- **Holidays** (Workforce → Holidays) — the company holiday calendar, by year. Each
  holiday has a pay multiplier and a bill multiplier, time and a half by default.
  - **Which shifts count.** A shift counts when it *starts* on the holiday, the same
    rule that decides which day's pay rate applies. The day is the date itself, not
    the weekday a bank observes it on: a post is open on the Saturday the Fourth falls
    on.
  - **Pay.** W-2 officers paid by the hour, the people who earn overtime, get the
    holiday premium on top of straight time. Holiday hours that are also overtime get
    the larger premium, not both. At time and a half each, that means overtime already
    covers them.
  - **Billing.** The client is billed at the holiday rate, on its own invoice line
    naming the holiday and the multiplier. The premium those hours pay counts in the
    line's cost, so margin stays honest.
  - **Where it shows.** The schedule marks the day. The payroll register, its CSV
    export, Timesheets and the payroll report carry holiday hours and the premium. An
    officer sees a holiday shift marked on their roster (web and phone), the next
    holiday on their schedule, and holiday pay on their pay stubs.
  - **Managing it.** Administrators add, change and remove holidays, or add the six
    usual ones (New Year's Day, Memorial Day, Independence Day, Labor Day,
    Thanksgiving and Christmas) in one step. The other federal holidays are listed to
    add one at a time. Supervisors can read the calendar but not change it.
  - **Locks.** A holiday in a closed pay period cannot be added, changed or removed.
    Invoices already sent keep their figures, and a change says how many cover that
    day.
- **Commendations** — on each officer's record: every commendation from a client or
  a supervisor, with **Commend** to add one (a supervisor never commends themselves).
  A client's thanks goes to the alerts inbox for a week; an administrator can remove
  one that should not have been sent, on the audit log.
- **Live dashboard** — who is on post right now, minutes on post, missed check-ins,
  officers outside their geofence, unfilled shifts, and a strip counting who is off
  post or has not clocked in for a shift that has started.
- **Live tracking** — every officer's actual position against their assigned post, on a
  map and in a table: status (on post, off post, on break, late, no-show, starting
  soon), the job and its address, the shift window, clock-in time and lateness, distance
  from the post with GPS accuracy and how long ago it was seen, missed check-ins, and
  hours today and this week with an overtime marker. Anyone outside the fence gets a
  dashed line back to where they should be. Filters by attention, site and search;
  refreshes every 20 seconds. Each officer's **GPS track** for any day replays the trail
  they walked, time inside the fence, walk-offs and distance covered.
- **Punch log** — every clock-in, clock-out, break start and end, answered and missed
  check-in, with the position, geofence verdict, distance from the post, method and
  device. Filter by date range, officer, site, punch type or "outside the geofence only";
  print or export CSV.
- **Pay rates** — every officer's classification (W-2 or 1099), pay basis, rate,
  overtime rate, bill rate and margin in one table, with 28-day hours and pay. Change a
  rate with an **effective date and a reason**; raise a whole group at once (W-2 or 1099,
  armed or unarmed, by percent or dollars) with a preview first. Every change - from
  this screen, a bulk raise or the employee record - lands in the rate history.
  Supervisors can read rates; only administrators can change them.
- **Client requests** — extra coverage clients have asked for from the portal. A
  supervisor schedules a request (which puts that many open shifts on one of the site's
  posts, armed posts only for an armed request) or declines it with a reason the
  client reads. The dashboard and menu count the ones waiting.
- **Payroll** — weekly (or up to four-week) pay periods, each reviewed officer by
  officer: hours, regular and overtime pay, gross, sites worked, and what needs a second
  look (open shifts, corrected punches, off-site clock-ins, unresolved flags, missing
  W-9s, corrections still waiting). A time correction waiting on hours in the period
  stops it closing until it is decided. Approve one, a selection or everyone ready; an approval is pinned to the exact
  hours and rates, so a later correction shows as **changed since approval**. Closing
  freezes the figures and locks the period against punch corrections and back-dated
  rates until it is reopened with a reason. Exports a payroll register CSV, W-2 and
  1099 separately. Approved expense claims are paid with the close, listed under
  **Expenses this close pays** and as a Reimbursements column in the register, kept
  apart from gross pay; a claim waiting for a decision stops the period it falls in
  closing, and reopening a period hands its claims back.
- **Reports** — fourteen reports over any period, site, officer or classification, each
  with summary figures, a chart, a sortable table with totals, print and CSV export:
  hours &amp; pay by officer, the **payroll register** (W-2 overtime decided week by week;
  1099 payees with W-9 status and masked TIN), overtime watch, hours &amp; margin by site,
  where officers worked, daily hours, attendance &amp; punctuality, GPS &amp; geofence
  compliance, **supervisor visits by site** (visits, rating, problems found, days since
  the last one), and three on incidents: **by site** (how serious, police called, still
  open), **by type** (with the serious share and the average hours to close) and **by
  day** (to spot a bad week, with the busiest day and worst weekday).
- **Safety &amp; live map** — open duress alerts with one-tap call and directions, plus a
  map of every post, its geofence, and where each officer actually clocked in.
  Refreshes every 15 seconds.
- **Employee profiles** — contact details, mailing address, emergency contact and
  relationship, uniform size, hire date, home site, internal notes, and
  **PIN generation/reset shown once**.
- **Employment classification** — W-2 or 1099 per person, with the paperwork that goes
  with it. A 1099 cannot be made active without a W-9 on file, and "exempt" is refused
  on a contractor. Contractor records carry business name, tax ID last four, signed
  agreement and certificate-of-insurance expiry.
- **Pay &amp; billing** — hourly, salary or per-shift; pay rate, client bill rate, and
  overtime multiplier. A live preview shows a worked example before you save.
- **Schedule** — a roster grid by officer (weekly hours per person, overtime flagged,
  click any empty day to add a shift) or by day, conflict detection, **copy a week's
  roster forward** (clashes are left open rather than double-booked), a recurring roster
  builder that handles overnight shifts, and print.
- **Suggested officers** — adding or editing a shift ranks everyone who could cover it:
  eligible first (current Class G for an armed post, no overlapping shift, no approved
  leave, within their stated availability), then without overtime, then those who have
  worked that post before or are based at that site. Each shows their hours that week
  with the shift added, overtime it would cause, what it would cost and the margin.
  Picking someone who should not take it shows why before you save, and the API
  refuses the assignment unless the supervisor overrides it with a written reason,
  which goes on the audit log. Recurring rosters skip days the officer cannot work,
  and copying a week leaves those shifts open.
- **Officers are told** — adding, moving, reassigning or removing an upcoming shift
  sends the officer a push notification, and a recurring roster or copied week sends
  one summary instead of dozens.
- **Shift requests** — open shifts officers can claim, swaps they can offer each other,
  and drop requests, all landing in one supervisor queue. Eligibility is checked at
  every step, so an officer without a current Class G licence cannot end up on an armed
  post; approving a claim automatically declines the officers who lost out.
- **Invoices** — raised from hours already on the clock at the bill rate that applied,
  one line per post, plus a line of its own for hours on a company holiday at the
  holiday rate. Preview before committing, tax and payment terms per invoice, a
  printable invoice document and CSV export, and a receivables view with margin and an
  overdue count. A period that overlaps an existing invoice is flagged before the same
  hours get billed twice. **Client questions** (a tab, and on each invoice) lists what
  clients have asked, waiting ones first, each answered in place; a waiting question is
  in the alerts inbox.
- **Service agreements** (Billing → Service agreements) — the hours a week each property
  pays for, its start and end dates, notice period and whether it renews on its own,
  with internal notes. Each site is shown against the next 7 days' roster (filled
  shifts, then open ones nobody has taken, against the contracted line) and the hours
  worked in the last 7. A site rostered more than half an hour short of its agreement,
  and an agreement inside its notice period, are in the alerts inbox and counted on the
  sidebar. The **hours against agreements** report spreads the weekly figure over any
  date range and sets the hours worked against it. Administrators edit; supervisors
  read.
- **Fleet** (Operations → Fleet) — every patrol vehicle: who has it and whether they
  checked it, the last check, the odometer, miles over the last 7 and 30 days, and the
  next service against the odometer. A vehicle with a failed safety check is **off the
  road**: it can't be signed out, and it goes into maintenance when it comes back,
  until a supervisor signs the repair off. Each vehicle's record has its open defects,
  a **Record a service** form (the next one defaults to 5,000 miles on), every check
  and service, and its trips. The alerts inbox raises vehicles off the road (critical),
  vehicles signed out for 30 minutes without a start check, and services due or
  overdue. The **patrol vehicle mileage** report covers any date range.
- **Expenses** (Workforce → Expenses) — officers' expense claims: waiting, approved,
  paid and declined, with totals, the receipt photo, and **Approve** or **Decline**
  (with a reason the officer reads). Only an administrator decides, and never their
  own claim; supervisors see the queue. New claims go to the alerts inbox.
- **Shift confirmations** — the dashboard's **Not confirmed yet** card lists every
  officer due on post in the next 12 hours who has not confirmed, critical inside 2
  hours, with whether the reminder went out, a tap-to-call number and **Confirmed by
  phone** (with an optional note) for the answer taken on the phone. Each is also in the
  alerts inbox, and the next-12-hours table and the schedule board show who has
  confirmed.
- **Client portal logins** — create a read-only account for a site contact, choose which
  properties it can see, reset the password or suspend it.
- **Outbox** — every message the system decided to send: invoice notices to client
  contacts, portal account notices. Each one is recorded whether or not a mail provider
  is configured, so with no provider set this becomes the list of what to send by hand,
  with the text ready to copy. Passwords are never included in a message.
- **Timesheets** — hours by officer with the regular/overtime split **driven by
  classification**, unpaid break deductions, exception badges, estimated pay, client
  billing and margin, every individual punch, and **CSV export for payroll**. The
  **Corrections** tab lists officers' requests to fix a punch, as recorded and as they
  should be, with the hours either way and why. An administrator approves (the shift is
  corrected the same way as their own corrections, the recorded times kept, a late flag
  or a system-closed flag resolved when the new times settle it) or declines with a
  reason the officer reads; supervisors see the queue. Waiting requests are in the
  alerts inbox and counted on the sidebar.
- **Time off** — approve or deny with a note; approving reports how many rostered
  shifts still need re-covering. A request paid from a balance shows the hours and the
  balance they come from; approving spends them, and is refused if they are no longer
  there. The next payroll close pays it at the officer's rate on the day, listed under
  **Paid time off this close pays** and in the register's PTO columns, beside (not inside)
  the pay for hours worked; a paid request waiting for a decision holds the close up,
  and a reopen hands it back and takes back the hours the close credited. Each
  employee's record has their balance and statement, and an administrator can
  **Adjust** it with a reason (a carry-over, a payout, a mistake), within 0 to 80 hours.
- **Licensing &amp; certifications** — one board for state licences, certifications and
  contractor insurance, showing what has expired and what lapses in the next 30/60/90
  days.
- **Daily Activity Report** — the client-facing document, assembled from the day's
  clock, patrol and incident data, laid out to print straight to PDF.
- **Flags** — the compliance queue: late clock-in, missed check-in, geofence violation,
  missed clock-out, early departure, no-show. Closing one requires a written outcome.
- **Incidents** — review queue with severity adjustment and notes back to the officer.
  **Print report** turns an incident into a one-page document for an insurer, the police
  or the client's file: the facts, what happened, how it was resolved, who was notified
  and the shared follow-ups with their owners. Review notes, cost recovery and internal
  follow-ups stay off it. Clients print the same document from the portal, without the
  owners.
  **Follow-ups** turn a serious incident into the things that have to happen next
  ("get the fence panel repaired", "pull the camera footage for the police"): each has
  an owner (a supervisor or administrator), a due date, and is marked done only with a
  note of what was done. The Follow-ups tab lists them across every incident (open,
  overdue, mine, all), an overdue one lands in the alerts inbox, and each is either
  shared with the client or kept internal.
- **Sites & posts** — set each post's location **on a map** (search an address, drop or
  drag the pin, or use your current position), with the geofence drawn to scale.
  Check-in cadence, post orders and the armed flag live here too.
- **Tours** — build routes and checkpoints, and see completed walks as proof of service.
  **QR tags** prints a tag for every checkpoint on a tour (three to a page, in walking
  order), each encoding the checkpoint's own tag ID, or `USC-CP-<id>` when it has none.
- **Audit log** — every sign-in, clock event, PIN reset and record change.

### Client portal (web, `/portal`)

A read-only window for the people paying for the guarding. A contact signs in with an
email and password — a different identity space from staff, who use an employee code and
a PIN — and sees, for their own properties only:

- **Coverage at a glance** — who is on post right now, the week's coverage percentage,
  hours on site, patrols walked and incidents.
- **Coverage record** — every scheduled shift with who stood it and when they clocked in
  and out. A shift reads *Scheduled*, then *Awaiting clock-in*, and only becomes *Not
  covered* once it has ended with nobody on it. **Coming up** shows the next 7 or 14
  days, day by day: who is booked on each post, and any shift we are still arranging.
- **Notices from us** — a hurricane plan, holiday coverage, a lobby moving: shown at the
  top of every page until the contact marks it read, most urgent first. A notice for
  one property is seen only by that property's contacts, and never names the other
  properties it went to.
- **Patrol proof** — each round walked, with every checkpoint scanned, skipped or
  missed, and the time it was reached.
- **Incidents** — the full report, including photographs, which are served through the
  API rather than handed out as storage URLs, and **what we are doing about it**: the
  follow-ups shared with the client, each shown in hand with its due date or done. Who
  owns them and the internal note on how each was closed stay with us. When a shared
  follow-up is done, the contacts who take serious incident alerts are emailed once,
  with what is still in hand.
- **Supervisor visits** — each visit to the property, when and at which post, with the
  supervisor's note for the client. Their internal notes, the rating and the officer's
  name are not shown.
- **Daily activity report** — the same document the account manager reviews, laid out to
  print straight to PDF, including who came through the building: every visitor,
  contractor and delivery the officers signed in, when they arrived and left, and their
  vehicle. The officer who logged them is not shown. Parking enforcement on the
  property that day is listed too, along with the officers' activity log (without
  entries marked internal) and any building issues reported.
- **Invoices** — their own issued invoices, with the hours and the rate charged, as a
  printable document they can save as a PDF. **Holiday rates** lists the holidays ahead
  and what each bills at, but not what officers are paid for them. The upcoming
  coverage marks a shift that falls on one. **Ask about an invoice** — the whole of it
  or one line — and the answer arrives in the portal and by email; up to three
  questions can wait on one invoice at a time, and the list shows which have one
  waiting.
- **Building issues** — on the overview: whatever our officers found wrong with the
  property, urgent first. The client marks each one "seen, it's in hand" or "fixed",
  with a note for the officer on post. The officer who reported it stays internal.
- **How are we doing?** — a one-to-five rating for the month per property, changeable
  within the month; a low one needs a reason. Our reply appears underneath.
- **Commend an officer** — thank an officer who worked the property in the last 60
  days, for customer service, vigilance, an emergency, professionalism, teamwork or
  going above and beyond. The officer reads it word for word and it goes on their
  record; the client sees what they have sent, and nothing else about the officer.
- **Who our officers call** — the client keeps their property's contacts current,
  and officers on post see the changes at once.
- **Post orders** — what the officers are instructed to do at each of their posts, the
  version in force and when it took effect (not which of our staff wrote it). A client
  can **ask for a change**, up to three waiting per post; a supervisor applies it as a
  new version or declines it with a reason, and the client sees the answer in the
  portal and by email. A request nobody has answered can be withdrawn.
- **Monthly service report** (Report → Monthly report) — one property's month on a page:
  shifts covered and hours on site, per post; patrols and the share of checkpoints
  scanned; every incident by severity; visitors, parking violations, activity entries,
  supervisor visits and lost property; building issues reported, fixed and still open;
  the miles the property's own patrol vehicles covered; and their own rating. The current month runs to today. Laid out to print or save as a
  PDF.
- **Email me** (account menu) — each contact chooses their emails. **Serious incident
  alerts** (on by default): a high or critical incident at their property is emailed
  once, when it is filed or when a supervisor raises it to serious on review, with the
  reference, category, time and place but never the officer's name or an internal
  note. **The daily report** (opt-in): each morning's sweep emails yesterday at each
  of their properties (officers and hours, patrols and checkpoints, incidents,
  visitors, activity, open building issues), once per contact, site and day.
- **Confirmed shifts** — under Coverage → Coming up, a shift whose officer has told us
  they will be there is marked **Confirmed** (how and by whom stays internal).
- **Hours against your agreement** (on the overview) — for each property with a
  service agreement: the hours a week it pays for, when it runs to, the hours worked in
  each of the last four weeks we have records for (as a bar against the contracted
  line and a percentage) and what is rostered for the next 7 days.
- **Calls** — ask for an officer now: urgent or routine (an emergency is a 911 call, and
  the form says so first), what it is about, where and what is happening. The client
  follows it from called in to officer sent, on the way and on scene, can cancel it
  until the officer arrives, and is emailed when it is cleared with what was found.
  The calls the office raised for their property are listed too, with how long our
  officers took to get there.
- **Extra coverage requests** — officers beyond the
  standing roster for an event or a stretch of extra risk (date, times, how many, armed
  or not, and what it is for). The office schedules it or declines it with a reason;
  the client sees the answer in the portal and by email, and can withdraw a request
  nobody has answered yet.

What a client can never see: another client's property, any pay rate, classification or
margin, an officer's employment record, or the internal review notes on an incident.
`apps/server/test/portal.mjs` exists to keep that true, and checks it by walking every
response for those fields rather than trusting the queries to stay right.

### Maps

Locations use OpenStreetMap through Leaflet, so the map works with **no API key and no
billing account**. Every location also carries an *Open in Google Maps* / *Directions*
link, which is what an officer or responding supervisor actually wants.

Set `USC_MAPS_API_KEY` and address lookup switches to Google's geocoder; without it the
app falls back to OpenStreetMap's Nominatim. Either way an admin can always place the
pin by hand.

---

## Layout

```
usa-security-connect/
├─ packages/shared/        Brand tokens + business rules used by all three surfaces
├─ apps/
│  ├─ server/              Node + Express API, Postgres, JWT, compliance engine
│  ├─ web/                 React + Vite (officer app, admin console, client portal)
│  └─ mobile/              Expo / React Native (Android + iOS)
├─ api/index.js            The same Express app, as a Vercel function
└─ docs/
```

`packages/shared/src/domain.js` holds the thresholds — grace period, check-in window,
geofence radius, overtime line — so changing a rule changes it everywhere at once.

### Stack notes

- **Postgres, two drivers, one data layer.** Production uses Neon over HTTP;
  development and CI use **PGlite** — Postgres compiled to WebAssembly — so there is no
  database server to install and no Docker. Both are real Postgres running the same
  schema (`apps/server/src/lib/schema.js`), and `apps/server/src/lib/db.js` is the only file that knows which is in
  use. Money is stored in integer cents, calendar fields as `date`, events as
  `timestamptz`.
- **One Express app, two front doors.** `src/index.js` listens on a port; `api/index.js`
  exports the same app as a Vercel function. The schema is applied lazily on the first
  request, so a cold start costs one round trip and nothing afterwards.
- **PINs and portal passwords** are hashed with scrypt and a per-record salt, never
  stored or returned in readable form. Five wrong attempts locks the account for 15
  minutes; sign-in is rate limited per IP *and* per employee code or email.
- **Staff and clients are separate identity spaces.** Both tokens are signed with the
  same secret and both subjects are small integers from different tables, so each token
  carries the kind it is and each middleware refuses the other.
- **The compliance sweep** (`apps/server/src/services/compliance.js`) runs on a timer on
  a long-running host, and via `POST /api/cron/sweep` behind `CRON_SECRET` where there
  is no such process. It is idempotent — a unique constraint on the flag means running
  it repeatedly never duplicates an alert.

---

## Brand

Sampled from usasecuritygroup.com:

| Token | Value | Use |
|-------|-------|-----|
| Navy | `#001F3F` | Headers, admin sidebar, primary surfaces |
| Brand red | `#AA2F19` | Primary actions, active states |
| Accent | `#E66952` | Highlights |
| Charcoal | `#292929` | Body text |

Defined once in `packages/shared/src/theme.js`, mirrored as CSS custom properties in
`apps/web/src/styles/app.css` and as a JS object in `apps/mobile/src/theme.js`.

**The mark** is "Chrome Guardian": a polished chrome shield with navy and red enamel
fields and a raised silver pin. It is drawn once, in `apps/web/src/components/shieldMark.js`.
The web app's `<Shield>` renders it everywhere: the header, the sign-in screens, the
portal and the printed daily report. A bar of light crosses it on hover, and once as a
sign-in screen opens; nothing moves for anyone who prefers reduced motion. Every other
image of the mark is generated from that file:

```bash
USC_CHROMIUM_PATH=/path/to/chromium node apps/web/tools/make-icons.mjs
```

This writes the favicon (`public/shield.svg`), the installed-app icons (192, 512,
maskable 512 and the iOS home-screen icon) and the mobile app's `assets/shield.png`,
`icon.png` and `adaptive-icon.png`. To change the logo, edit `shieldMark.js`, run the
script, and bump `CACHE` in `apps/web/public/sw.js` so installed copies fetch the new
icons.

---

## Configuration

| Variable | Where | Default | Notes |
|----------|-------|---------|-------|
| `PORT` | server | `4000` | |
| `DATABASE_URL` | server | unset | A Postgres connection string (Neon). Without it the server uses a local PGlite database, which is what `npm run dev` does. |
| `USC_JWT_SECRET` | server | dev-only fallback | **Required in production** — the server refuses to start without it when `NODE_ENV=production`. |
| `USC_TOKEN_TTL` | server | `12h` | Staff session. Long enough for a full shift. |
| `USC_CLIENT_TOKEN_TTL` | server | `8h` | Client portal session. Shorter: they are not mid-shift. |
| `CRON_SECRET` | server | unset | Required to call `/api/cron/sweep`. Set it on any host without a long-running process. |
| `BLOB_READ_WRITE_TOKEN` | server | unset | Vercel Blob. Without it, incident photos go to `USC_DATA_DIR/uploads`. |
| `USC_DATA_DIR` | server | `apps/server/data` | Local PGlite database + incident photos, when neither of the above is set. |
| `USC_ALLOWED_ORIGINS` | server | all | Comma-separated list; set this in production. |
| `USC_MAPS_API_KEY` | server | unset | Google geocoding key. Without it, address lookup uses OpenStreetMap. |
| `USC_PUSH_DISABLED` | server | unset | Set to `1` to switch push delivery off (used by the test suite). |
| `USC_MIN_PING_GAP_SECONDS` | server | `20` | Location reports closer together than this are acknowledged but not stored. The test run shortens it. |
| `USC_LOGIN_LIMIT_PER_IP` / `USC_LOGIN_LIMIT_PER_CODE` | server | `60` / `10` | Staff sign-ins allowed per five minutes. Raised only for the local test run; leave unset in production. |
| `USC_EMAIL_API_KEY` | server | unset | A [Resend](https://resend.com) API key. Without it nothing is sent; messages are still composed and recorded in the outbox. |
| `USC_EMAIL_FROM` | server | Resend's test sender | e.g. `USA Security Connect <billing@usasecuritygroup.com>`. The domain must be verified with your provider. |
| `USC_EMAIL_DISABLED` | server | unset | Set to `1` to switch email off even when a key is present (used by the test suite). |
| `USC_PUBLIC_URL` | server | unset | Your deployed URL, used for the portal link inside messages. |
| `VITE_API_URL` | web | `/api` (proxied) | |
| `EXPO_PUBLIC_API_URL` | mobile | `10.0.2.2` / `localhost` | Point at your real API for device builds. |

---

## Before going live

1. **Set `USC_JWT_SECRET`** and `USC_ALLOWED_ORIGINS`, and serve everything over HTTPS —
   PINs, passwords and tokens must never cross plain HTTP.
2. **Point `DATABASE_URL` at a real Postgres** (Neon, or anything else). PGlite is for
   development and CI; it is single-writer and lives on local disk.
3. **Set `CRON_SECRET` and schedule the sweep** if the API is serverless. Without it,
   late and missed-check-in flags are never raised. On a long-running host an internal
   timer does this and no secret is needed.
4. **Create the first administrator** with `node apps/server/tools/create-admin.mjs`.
   The demo seed must never run against production.
5. **Back up the database and the photo store**, and test the restore.
6. **Review the retention policy** for GPS traces and photos with counsel; the audit
   log, timesheets and invoices are designed to be kept, but location history may not
   need to be.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the step-by-step version.

### Shipping the apps

The Expo project is configured and bundles for both platforms, but store binaries still
need a build step this project has not run:

```bash
cd apps/mobile
npx eas build --platform android    # AAB for Google Play
npx eas build --platform ios        # needs an Apple Developer account
```

- **iOS** builds require macOS or EAS's hosted macOS builders.
- **NFC tag scanning** is built and wired to the tour screen, but the native module only
  exists in a development or production build — it will not work in Expo Go. The app
  detects this and falls back to typing the tag ID or marking the checkpoint visited;
  the server validates the tag identically either way.
- **Push notifications** are built end to end (device registration, urgent broadcasts,
  check-ins falling due, duress alerts, messages). They need `eas build:configure` to
  write a project ID into `app.json`, and FCM/APNs credentials via `npx eas credentials`.
  Until then the app logs a warning and carries on without them.

See [apps/mobile/BUILDING.md](apps/mobile/BUILDING.md) for the full build walkthrough.

---

## Tests

One command reseeds the database, starts the API, runs all 34 steps and stops it:

```bash
npm run verify --workspace @usc/server            # add --fresh to wipe the database first
```

The order matters and the script enforces it: PGlite is single-writer, so seeding while
the server is running corrupts the data directory.

- **`test/smoke.mjs`** — authentication, PIN lockout, geofenced clock-in, status
  check-ins, tours and NFC tag validation, training enforcement, scheduling conflicts,
  the compliance sweep and the payroll export.
- **`test/features.mjs`** — employment classification rules, overtime by worker type,
  margin, certification expiry, availability, time off, breaks, duress alerts, the
  daily report, map data and push registration.
- **`test/shifts.mjs`** — open shifts, claiming, swaps and drops, and the armed-post
  licence rule from both sides.
- **`test/portal.mjs`** — client scoping, mostly negatively: that one client cannot see
  another's property, that a client token cannot reach a staff endpoint and vice versa,
  and that no pay or personnel field appears in any response. The schedule ahead covers
  only their own posts, at most 14 days, without pay or staff ids. Notices reach only
  the properties they were posted to, validate their audience, level and dates, can be
  scheduled, are marked read once per contact and counted, email only their own
  contacts, and leave the portal the moment they are withdrawn.
- **`test/invoices.mjs`** — the billing arithmetic, recomputed from the hours rather
  than trusted; status transitions; and that cost and margin never reach the portal.
  Client questions: only about their own issued invoices and lines on them, three
  waiting at most, answered once by a supervisor or administrator, emailed, audited,
  raised in the alerts inbox until answered, and never naming who answered.
- **`test/email.mjs`** — what gets composed, who it is addressed to, and above all that
  no generated password appears in any message.
- **`test/tracking.mjs`** — location reports (thinned, judged, never stored off duty),
  one walk-off flag however long an officer stays out, the live board, GPS tracks, the
  punch log and its filters, pay-rate changes and history, bulk raises that touch
  exactly who they should, every report - with W-2 overtime recomputed week by week
  from the raw punches rather than trusted - and copying a week's roster.
- **`test/requests.mjs`** — client coverage requests across the client/staff line: a
  client sees and touches only their own property's requests, answering one puts exactly
  that many open shifts on the right post and emails the client, and an officer's own
  pay matches the payroll line it comes from to the cent.
- **`apps/web/test/roles-e2e.mjs`** — signs in through the real screens as an
  administrator, a supervisor, a W-2 officer, a 1099 contractor, an officer who must
  change their PIN and a client, opens every screen each one is offered, and fails on
  any refused or broken request, script error, error message, blank page or sideways
  scroll. Ends with a client requesting coverage and a supervisor scheduling it. Then
  an officer on post signs a visitor in, which the supervisor sees under Post logs and
  the client sees in the day's report. The supervisor also finds the officer with
  Ctrl+K, issues new post orders the officer then reads and acknowledges, opens an
  alert from the bell, and prints a tour's QR tags. Last, a client asks for an officer
  from the portal, a supervisor sends the call to the officer at the property, who
  acknowledges, arrives and clears it from their phone, and the client sees it cleared
  with the response time. Then an officer asks for a clock-out to be fixed and an
  administrator approves it, an administrator sets a service agreement for a
  month-to-month site, and an officer confirms their next shift, a supervisor records
  another confirmed by phone and the client sees which shifts are confirmed. Last, the
  officer checks the patrol truck before driving and hands it back with the end check,
  and a supervisor signs a brake repair off on the Fleet page. Last, an officer claims
  miles from their phone, an administrator opens a receipt and approves the claim, and
  the pay period lists the expenses it pays. Then an officer asks for four hours of
  paid time off from their phone, a supervisor sees the balance and approves it, the
  officer's statement shows it spent, and the pay period lists the time off it pays.
  Last, a client commends an officer from the portal, the officer reads it on their
  home screen, and a supervisor adds one from the officer's record. Then a supervisor
  opens the overtime watch for next week and follows **Find cover** to the shift that
  tips an officer over, which opens with the overtime warning and the suggestions.
- **`test/postlog.mjs`** — the visitor log and pass-down notes, mostly the lines
  around them: an officer off duty cannot write to any post's log, cannot sign out a
  visitor at another site, and cannot read or acknowledge another post's notes. A
  client sees only their own building's visitors, without the officer's name. Also
  checks the quick search: literal wildcards, and no PINs or pay in the results.
- **`test/watch.mjs`** — the watchlist at the desk: matches on name (any case or
  spacing), alias and plate, but not on a similar name, an expired entry or another
  site's. An override needs the matching entry and a reason, and stays on the
  record. Vehicle violations count a plate as the same however it is written. A
  plate lookup shows a repeat offender and the visit it came in with. Scorecards
  are bounded, ranked, and add up.
- **`test/sitelog.mjs`** — activity entries can only be written by an officer on
  duty, for a time within their shift. The client never sees internal entries or
  another client's site. A building issue goes from officer to client and back:
  the client acknowledges it, fixes it, and a fixed issue stays closed to them,
  while a supervisor can reopen it. Found items leave only with a name and a
  contact, and only supervisors dispose of property.
- **`test/contacts.mjs`** — contacts from both sides: a client edits only their own
  properties' contacts, and officers read those for the site they are on. Feedback
  is one rating per contact, property and month; a low rating needs a reason, and
  the reply reaches the client without our staff member's name. Every export
  downloads as a real CSV, with formulas neutralised. The monthly service report is
  scoped to the client's own property, its posts add up to its totals, the counts are
  consistent, the month is validated, and it carries no pay, rate or staff detail.
  Site health is worst first, its numbers match each client's report, and only
  supervisors see it. The end-of-shift summary counts the officer's own shift only,
  and knows when they have left a pass-down note. Client email alerts go only to the
  property's contacts who want them, once per incident (a later review does not
  repeat it), without the officer's name; the daily report goes once a day however
  often the sweep runs.
- **`test/orders.mjs`** — post orders, the alerts inbox and QR tags. An officer can
  acknowledge only the version in force, for their own post; a new version, from the
  orders screen or the Sites screen, has to be read again, and the supervisor's list of
  who has not read it is right. Alerts are ranked by severity, carry a link to where
  they are handled, and read marks are per person. A checkpoint accepts its NFC tag,
  its QR code or its own printed code, and refuses another checkpoint's. Clients read
  only their own posts' orders, without the author; a request is scoped to their own
  post, capped at three waiting, applied only to its own post and answered once, and
  both answers reach the client in the portal and by email. Incident follow-ups are
  supervisors' only, owned by a supervisor or administrator, closed only with a note,
  reopened cleanly, counted and filtered correctly, raised in the alerts inbox when
  overdue and dropped once done; the client sees only the shared ones, without owner or
  note, and the officer who filed the incident does not see them. The incident reports
  agree with each other, refuse a range over a year, and export as CSV with a total.
  A follow-up done emails the client once, without our note, and an internal one never.
- **`test/visits.mjs`** — supervisor field visits. A visit is tied to a real site and
  post (the post decides the site), a real officer, and a time no later than now and
  no more than a week back. Supervisors see every visit and filter it; an officer sees
  only the visits made to them. The client reads only the note written for them - not
  the internal notes, the rating or the officer's name, in the visit list or the daily
  report. Sites with no visit in 14 days are due on the board, the sidebar badge, the
  alerts and site health, and drop off all four once visited. The visits report covers
  every site, adds up, and exports.
- **`test/hiring.mjs`** — the public form validates every field, emails a
  confirmation, takes one open application per email, and thanks a bot that fills
  the hidden field without keeping anything. The pipeline is staff-only; hiring needs
  an offer, the required checks and an administrator, happens once, carries the
  licence over, returns a code and a PIN that sign in and must be changed, and never
  the PIN hash. Moves, checks, notes, rejections with a reason and reopening are
  checked, and audited.
- **`test/dispatch.mjs`** — a call goes only to an officer on the clock; only that
  officer or a supervisor can move it on, one step at a time, and it cannot be cleared
  before they are on scene; turning it back needs a reason; every step is timed and
  logged. Clients raise urgent or routine calls (never emergencies) at their own sites
  only, three open at a time, see the officer by first name but no phone numbers or
  internal log, cannot cancel once the officer is there, and are emailed when it is
  cleared. Clocking out puts an open call back on the board. Alerts, the sidebar
  count, the report and the audit trail are checked.
- **`test/corrections.mjs`** — an officer can ask about only their own finished shifts
  from the last 14 days, once at a time per shift, with a reason and times that are not
  in the future, not the ones recorded and not hours already paid. Supervisors see the
  queue; only an administrator decides, once. Approving moves the shift and keeps the
  recorded time; declining leaves it and tells the officer why; a withdrawn request
  cannot be approved. A waiting request holds up that week's pay period. Every step
  is audited.
- **`test/agreements.mjs`** — supervisors read the board, officers and visitors cannot;
  only an administrator sets or removes an agreement, with real hours and dates. A site
  rostered short is flagged, raised and counted, and the alert clears when the roster
  meets it; an agreement in its notice period is due for renewal unless it renews on
  its own. A client sees their own properties' agreements and weekly hours without our
  notes. The report and the audit trail are checked.
- **`test/confirmations.mjs`** — an officer confirms only their own shifts, within a
  week and before they start; a clocked-in or cancelled shift cannot be. Unconfirmed
  shifts inside 12 hours are listed, alerted (critical inside 2) and counted; the sweep
  reminds once a day ahead. A supervisor records a phone confirmation; the client sees
  which shifts are confirmed but not how. Moving a shift, or handing it away and back,
  drops the confirmation.
- **`test/vehicles.mjs`** — only the officer holding a vehicle checks it, and must
  answer every item, with a note for a problem. The odometer can't go backwards or
  jump wildly. A vehicle is handed back with its end check, which gives the miles. A
  minor fault stays on the road. A failed brake check takes the vehicle off the road:
  the same fault isn't logged twice, the vehicle goes into maintenance, it can't be
  signed out again, and it's back once a supervisor signs the repair off. Services
  reset the due mileage. Alerts, the mileage report and CSV, the client's monthly
  miles (without the drivers' names) and the audit trail are checked.
- **`test/expenses.mjs`** — claims: no future dates, nothing older than 60 days or
  over $1,000, a receipt over $25 (a photo or a PDF, nothing else), mileage priced from
  the miles. Only the claimant and staff open a receipt, and it is served so nothing in
  it can run. Supervisors see the queue but only an administrator decides, never their
  own claim, and a decline needs a reason. In payroll, a claim waiting for a decision
  holds up the close; approved, it is paid by it, carried in the register, and handed
  back by a reopen. The alerts, the dashboard count and the audit trail are checked.
- **`test/pto.mjs`** — paid time off: what the closed week credited, to hourly W-2
  staff and no contractor; requests refused for more than is free, for unpaid leave or
  for more than 12 hours a day; approving spends the hours and is refused once they
  are gone; deleting gives them back unless they were paid; adjustments only by an
  administrator, with a reason, within the cap. In payroll, a waiting request holds up
  the close; approved, the close pays it at the officer's rate, the register carries it
  (for someone with no hours that week too), and a reopen hands it back.
- **`test/commendations.mjs`** — a client commends only officers who worked their
  property lately, at that property, and learns nothing about them but the name; it
  sets up its own portal contacts so it does not spend the demo logins' sign-in
  allowance. The officer reads it and marks it seen; officers cannot commend; a
  supervisor commends anyone but themselves; client thanks reach the alerts inbox and
  the scorecards count them; only an administrator removes one, on the audit log.
- **`test/overtime.mjs`** — builds its own week: a new W-2 officer and a new 1099
  contractor, each rostered nine hours a day Monday to Friday next week. The officer
  is projected at 45 hours, 5 over, $50 of premium at time and a half, tipped over by
  Friday's shift; the contractor is not on the board. A Saturday on top adds to the
  overtime but Friday is still the shift that tips it. This week's avoidable overtime
  matches the sidebar count and the alerts inbox; officers cannot read the board.
- **`test/holidays.mjs`** — the premium rule on its own first:
  - 8 holiday hours at $20 pay $80 extra.
  - After 36 hours in the week, only the 4 hours under 40 get the premium.
  - At double time, the overtime hours get the half that double time pays beyond
    overtime.

  Then the calendar:
  - The usual holidays are seeded, and the federal ones not yet on it are offered.
  - Only an administrator changes it, with every bad date, name and multiplier refused.
  - There is one holiday a day, and the six usual ones go on in one step.
  - Nothing can be added to a closed pay period.

  Then a floater works eight hours on a recent open day, which becomes a holiday:
  - Her gross goes up by exactly half her rate on each hour, and the register says
    which holiday.
  - An earlier approval no longer stands, and the CSV carries the column.
  - The site's invoice preview turns into holiday lines at twice the rate for the
    same hours, with the premium in their cost.
  - Changing the bill multiplier reprices the day.

  Finally, who sees it:
  - The officer's roster, the supervisors' schedule and the client portal all mark
    the day, and clients never see the pay multiplier.
  - Removing the holiday takes the premium and the holiday lines back out.
- **`test/sweep.mjs`** — every endpoint, read from the source so new ones are
  included automatically. Every GET is called signed out, as an officer, a
  supervisor, an administrator and a client, then again with nonsense in every
  query parameter. Every POST, PATCH and DELETE is sent malformed bodies. Refusals
  are fine; a 5xx fails the run. Nothing but the public endpoints may answer
  without a session. Its first run found 14 endpoints that crashed on bad
  parameters, a broadcast receipt that failed when a message was acknowledged
  after being opened, and training progress that could never be saved on
  Postgres. All are fixed and checked here.
- **`test/payroll.mjs`** — pay periods end to end: approval, "changed since approved"
  after a corrected punch, pay agreeing with the reports to the cent, closing, and every
  way of changing a closed period's pay being refused until it is reopened.

The accessibility audit (`npm run test:a11y --workspace @usc/web`) drives 126 screens
and dialogs through axe-core, signed in as an administrator, an officer on post and a
client, then audits eleven screens again in night mode with colour contrast enforced
(the dark palette is ours, so a contrast failure there fails the run). It stops rather than carrying on if a sign-in fails, so it cannot quietly audit
the sign-in screen in place of the real ones. It also fails any screen showing a table
without one of our table classes, which renders with the browser's defaults; several
screens shipped that way before the check existed. Set `USC_CHROMIUM_PATH` if your Chromium is not where Playwright
expects it.

The mobile layout audit (`npm run test:mobile --workspace @usc/web`) opens every screen
as an administrator, an officer and a client, at 360 and 390 pixels wide, in light and
night mode (303 screens). On each one it measures the layout for faults a phone shows
and a desktop hides:
- text squeezed to a few letters a line;
- a word wider than its box;
- anything past the screen edge outside a scroller;
- text spilling over the side of its card, though still on the screen;
- a control with something else lying over its middle, so a tap lands on the other thing;
- controls drawn on top of each other;
- a page wider than the screen.

Set `USC_SHOT_DIR` to also save a full-page screenshot of every screen. Its first run
found 271 faults, including dashboard rows read one letter per line. Others were site
pickers and date rows pushing pages sideways, table columns squeezed to a word a line,
and a client tab bar with every label cut off. All are fixed. The check for something lying over a
control found the toast area: even with no message showing it left an invisible strip
across the middle of dialog buttons on a phone, so a tap there did nothing. It now lets
taps through.

`npm run check:schema --workspace @usc/server` verifies every expected column and table
exists after a migration.

### Time zones

A calendar day ("next week", "yesterday", a timesheet's date range) means the server's
local day, not the UTC one. The server runs each database session in the process's time
zone, so `current_date` in a query agrees with the day the code works out. Dates sent
as `YYYY-MM-DD` are read as local days too. The live demo runs on New York time.

CI runs the API suites twice: once in UTC and once with `TZ=America/New_York`. Bugs
of this kind stay hidden in UTC, where local and UTC days are the same, and show
up the evening before a UTC midnight. Run the same pair locally:

```bash
TZ=America/New_York npm run verify --workspace @usc/server -- --fresh
```

The browser suites take `USC_BROWSER_TZ` (for example `America/New_York`) to run the
browser in a different zone from the machine. Two checks depend on the time of day.
The demo never clocks Marcus in before a quarter past midnight. So in the first half
hour of a day his truck is not yet overdue for its check, and in the first hour no
check-in is due. The vehicle and scorecard suites expect exactly that, rather than
failing.

---

## Documentation

- [docs/HANDOVER.md](docs/HANDOVER.md) — **start here if you are picking this up.** Why
  it is shaped the way it is, the traps that have already bitten, and what is not
  finished.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — the rule reference: thresholds, flag types,
  roles, the PIN lifecycle and the pay calculation.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — GitHub, Neon and Vercel, step by step.
- [apps/mobile/BUILDING.md](apps/mobile/BUILDING.md) — store builds, NFC and push.
