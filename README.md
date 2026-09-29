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
| **Navigation** | 5 tabs | 23 destinations | 24 destinations |
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
  block completion until they are dealt with.
- **Schedule** — upcoming and worked shifts, hours, overtime, and anything flagged.
- **My pay** (on the profile page) — the officer's own pay basis, an estimate for the
  week so far, and every closed pay period: hours, regular and overtime pay, gross and
  where they worked, exactly as payroll approved it. A 1099 contractor sees *My
  payments*, with no overtime.
- **Broadcasts and training** — priority notices with read/acknowledge receipts, and
  required videos that cannot be marked complete until they have actually been watched.
- **Messaging** with supervisors and dispatch.
- **Supervisor visits** (supervisors only) — uniform, post orders, equipment and site
  checks, logged with GPS.
- **Duress button** — one tap plus a confirmation alerts every supervisor with the
  officer's name, post and position. It fires immediately rather than waiting on GPS,
  repeat presses update the same alert instead of flooding the board, and the officer
  is told the moment a supervisor acknowledges.
- **Meal and rest breaks** — meal time is unpaid and deducted from the shift; rest
  breaks stay paid.
- **Time-off requests** — pick dates and a reason; overlapping requests are refused,
  and the decision comes back as a notification.
- **Push notifications** for urgent broadcasts, check-ins that fall due, and messages.

### Admin console (web)

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
  W-9s). Approve one, a selection or everyone ready; an approval is pinned to the exact
  hours and rates, so a later correction shows as **changed since approval**. Closing
  freezes the figures and locks the period against punch corrections and back-dated
  rates until it is reopened with a reason. Exports a payroll register CSV, W-2 and
  1099 separately.
- **Reports** — eight reports over any period, site, officer or classification, each
  with summary figures, a chart, a sortable table with totals, print and CSV export:
  hours &amp; pay by officer, the **payroll register** (W-2 overtime decided week by week;
  1099 payees with W-9 status and masked TIN), overtime watch, hours &amp; margin by site,
  where officers worked, daily hours, attendance &amp; punctuality, and GPS &amp; geofence
  compliance.
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
  one line per post. Preview before committing, tax and payment terms per invoice, a
  printable invoice document and CSV export, and a receivables view with margin and an
  overdue count. A period that overlaps an existing invoice is flagged before the same
  hours get billed twice.
- **Client portal logins** — create a read-only account for a site contact, choose which
  properties it can see, reset the password or suspend it.
- **Outbox** — every message the system decided to send: invoice notices to client
  contacts, portal account notices. Each one is recorded whether or not a mail provider
  is configured, so with no provider set this becomes the list of what to send by hand,
  with the text ready to copy. Passwords are never included in a message.
- **Timesheets** — hours by officer with the regular/overtime split **driven by
  classification**, unpaid break deductions, exception badges, estimated pay, client
  billing and margin, every individual punch, and **CSV export for payroll**.
- **Time off** — approve or deny with a note; approving reports how many rostered
  shifts still need re-covering.
- **Licensing &amp; certifications** — one board for state licences, certifications and
  contractor insurance, showing what has expired and what lapses in the next 30/60/90
  days.
- **Daily Activity Report** — the client-facing document, assembled from the day's
  clock, patrol and incident data, laid out to print straight to PDF.
- **Flags** — the compliance queue: late clock-in, missed check-in, geofence violation,
  missed clock-out, early departure, no-show. Closing one requires a written outcome.
- **Incidents** — review queue with severity adjustment and notes back to the officer.
- **Sites & posts** — set each post's location **on a map** (search an address, drop or
  drag the pin, or use your current position), with the geofence drawn to scale.
  Check-in cadence, post orders and the armed flag live here too.
- **Tours** — build routes and checkpoints, and see completed walks as proof of service.
- **Audit log** — every sign-in, clock event, PIN reset and record change.

### Client portal (web, `/portal`)

A read-only window for the people paying for the guarding. A contact signs in with an
email and password — a different identity space from staff, who use an employee code and
a PIN — and sees, for their own properties only:

- **Coverage at a glance** — who is on post right now, the week's coverage percentage,
  hours on site, patrols walked and incidents.
- **Coverage record** — every scheduled shift with who stood it and when they clocked in
  and out. A shift reads *Scheduled*, then *Awaiting clock-in*, and only becomes *Not
  covered* once it has ended with nobody on it.
- **Patrol proof** — each round walked, with every checkpoint scanned, skipped or
  missed, and the time it was reached.
- **Incidents** — the full report, including photographs, which are served through the
  API rather than handed out as storage URLs.
- **Daily activity report** — the same document the account manager reviews, laid out to
  print straight to PDF.
- **Invoices** — their own issued invoices, with the hours and the rate charged, as a
  printable document they can save as a PDF.
- **Extra coverage requests** — the one thing a client can ask for: officers beyond the
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

One command reseeds the database, starts the API, runs every suite and stops it:

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
  and that no pay or personnel field appears in any response.
- **`test/invoices.mjs`** — the billing arithmetic, recomputed from the hours rather
  than trusted; status transitions; and that cost and margin never reach the portal.
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
  scroll. Ends with a client requesting coverage and a supervisor scheduling it.
- **`test/payroll.mjs`** — pay periods end to end: approval, "changed since approved"
  after a corrected punch, pay agreeing with the reports to the cent, closing, and every
  way of changing a closed period's pay being refused until it is reopened.

The accessibility audit (`npm run test:a11y --workspace @usc/web`) drives 46 screens
through axe-core. Set `USC_CHROMIUM_PATH` if your Chromium is not where Playwright
expects it.

`npm run check:schema --workspace @usc/server` verifies every expected column and table
exists after a migration.

---

## Documentation

- [docs/HANDOVER.md](docs/HANDOVER.md) — **start here if you are picking this up.** Why
  it is shaped the way it is, the traps that have already bitten, and what is not
  finished.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — the rule reference: thresholds, flag types,
  roles, the PIN lifecycle and the pay calculation.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — GitHub, Neon and Vercel, step by step.
- [apps/mobile/BUILDING.md](apps/mobile/BUILDING.md) — store builds, NFC and push.
